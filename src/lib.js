// 中継の判定ロジック。Workers と Node（テスト）の両方で動くよう、Web 標準 API だけを使う。

export const KEY_ARG = 'gh_mcp_relay_key';
// 転送先。コネクタの URL は、公式 GitHub MCP の URL のホスト部分だけを中継のものに置き換えたもの。
export const UPSTREAM_ORIGIN = 'https://api.githubcopilot.com';

const KEY_PREFIX = 'gh-mcp-relay';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;
const METADATA_PREFIX = '/.well-known/oauth-protected-resource/';
// 転送してよいパス。既定のツールセット（`/mcp`）、ツールセットを 1 つ選ぶ `/mcp/x/<ツールセット>`（`all` を含む）と、
// それぞれの読み取り専用版。どのツールを使えるかは REPO_TOOLS で決めるので、ツールセットは選ばない。
// `readonly`・`insiders` はツールセット名にしない（`/insiders` は試験中のツールが出るので通さない）。
const UPSTREAM_PATH_RE = /^\/mcp(?:\/x\/(?!(?:readonly|insiders)(?:\/|$))[a-z_]+)?(\/readonly)?\/?$/;

// 使ってよいツール。owner と repo を必ず取り、上流の API も repo のパスになる（key の repo の中に閉じる）と
// 確かめたものだけ。一覧に無いツールは、引数によらず使わせず、tools/list からも外す。owner/repo を取らない
// ツールは、使わない owner/repo を足されると引数の確認を通ってしまうので、一覧に入れない（search_*、
// Projects、create_repository、get_teams、gists、notifications、stargazers など）。上流がツールを足しても、
// ここに足すまでは使えない。
const REPO_TOOLS = new Set([
  // repos・git（fork_repository は本人のアカウントに fork を作るが、作った fork には key が無いので触れない）
  'create_branch',
  'create_or_update_file',
  'delete_file',
  'fork_repository',
  'get_commit',
  'get_file_contents',
  'get_latest_release',
  'get_release_by_tag',
  'get_repository_tree',
  'get_tag',
  'list_branches',
  'list_commits',
  'list_releases',
  'list_repository_collaborators',
  'list_tags',
  'push_files',
  // issues・labels
  'add_issue_comment',
  'get_label',
  'issue_read',
  'issue_write',
  'label_write',
  'list_issue_fields',
  'list_issue_types',
  'list_issues',
  'list_label',
  'sub_issue_write',
  'update_issue_comment',
  // pull_requests
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
  'create_pull_request',
  'list_pull_requests',
  'merge_pull_request',
  'pull_request_read',
  'pull_request_review_write',
  'request_copilot_review',
  'update_pull_request',
  'update_pull_request_branch',
  // actions
  'actions_get',
  'actions_list',
  'actions_run_trigger',
  'get_job_logs',
  // code_quality・code_security・dependabot・secret_protection・security_advisories
  'get_code_quality_finding',
  'get_code_scanning_alert',
  'get_dependabot_alert',
  'get_secret_scanning_alert',
  'list_code_scanning_alerts',
  'list_dependabot_alerts',
  'list_repository_security_advisories',
  'list_secret_scanning_alerts',
  'run_secret_scanning',
  // discussions
  'discussion_comment_write',
  'get_discussion',
  'get_discussion_comments',
  'list_discussion_categories',
  'list_discussions',
]);
// owner/repo を取らないが、どの repo にも届かないので許すツール。
const REPOLESS_TOOLS = new Set(['get_me']);
// owner/repo とは別に対象のアカウントや org を決める引数。中継は確かめられないので、付いていたら使わせない
// （fork_repository の organization で、許した repo を別の org に fork させない、など）。REPO_TOOLS のツールに
// こうした引数が足されたときの備えも兼ねる。repo を含まない ID（GraphQL の node ID や Issue の ID）で対象を
// 決める引数も、owner/repo を許した repo にしたまま別の repo のものを指せるので使わせない（pull_request_review_write の
// resolve_thread の threadId、discussion_comment_write の commentNodeID）。sub_issue_write の sub_issue_id・after_id・
// before_id は、別の repo の Issue を指せる穴が今の /mcp と同じく残るが、sub-issue を使えるほうを選んで通す。
const TARGET_ARGS = new Set([
  'organization',
  'org',
  'enterprise',
  'user',
  'username',
  'gist_id',
  'notificationID',
  'threadId',
  'commentNodeID',
]);
// 中継が通す JSON-RPC のメソッド。resources/read・prompts/get・completion/complete などは、
// owner/repo を引数ではなく URI などで渡すので確かめられない。通さない。
const ALLOWED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

// URL のパスから、転送先を決める。パスはそのまま公式 GitHub MCP に渡す。
export function matchRoute(pathname) {
  let kind = 'endpoint';
  let path = pathname;
  if (pathname.startsWith(METADATA_PREFIX)) {
    kind = 'metadata';
    path = pathname.slice(METADATA_PREFIX.length - 1);
  }
  if (!UPSTREAM_PATH_RE.test(path)) return null;
  return { kind, path, upstream: `${UPSTREAM_ORIGIN}${path}` };
}

// OAuth App で認可するときに求める scope。OAuth App の token は求めた scope しか持たないので、
// private の repo を読むには repo が要る。OAuth App のコネクタは readonly のパスで登録する
// （同じ URL のコネクタは 2 つ登録できない）ので、readonly のパスでだけ返す。GitHub App は scope を見ない。
export function oauthScope(path) {
  return /\/readonly\/?$/.test(path) ? 'repo' : null;
}

export function resourceMetadata(origin, path) {
  const scope = oauthScope(path);
  return {
    resource: `${origin}${path}`,
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
    ...(scope ? { scopes_supported: [scope] } : {}),
  };
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

// key を作る。形は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>`。
// 中身は読めるままにして、末尾の署名（HMAC-SHA256）で改ざんを防ぐ。
export async function createKey(secret, { repos, expires }) {
  if (!Array.isArray(repos) || repos.length === 0) throw new Error('repos が空');
  for (const repo of repos) {
    if (!REPO_RE.test(repo)) throw new Error(`repo の形が不正: ${repo}`);
  }
  if (expires && !EXPIRES_RE.test(expires)) throw new Error(`expires は YYYY-MM-DD: ${expires}`);
  const fields = [KEY_PREFIX, repos.map((r) => r.toLowerCase()).join(','), ...(expires ? [expires] : [])];
  const signed = fields.join(':');
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(signed));
  return `${signed}:${base64url(new Uint8Array(signature))}`;
}

// key の署名と期限を確かめ、許可する repo の一覧を返す。不正なら null。
export async function verifyKey(secret, key, now) {
  if (typeof key !== 'string') return null;
  const fields = key.split(':');
  if (fields[0] !== KEY_PREFIX || (fields.length !== 3 && fields.length !== 4)) return null;
  const signature = fields.pop();
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromBase64url(signature),
      new TextEncoder().encode(fields.join(':')),
    );
    if (!ok) return null;
  } catch {
    return null;
  }
  const [, repos, expires] = fields;
  if (expires && !(now < Date.parse(`${expires}T00:00:00Z`))) return null;
  return { repos: repos.split(','), expires };
}

// ツール引数に出てくる owner/repo の組をすべて取り出す（owner と repo、parent_owner と parent_repo など）。
export function reposInArgs(args) {
  const found = [];
  for (const [name, owner] of Object.entries(args ?? {})) {
    if (!name.endsWith('owner')) continue;
    const repo = args[`${name.slice(0, -'owner'.length)}repo`];
    found.push(`${owner}/${repo}`.toLowerCase());
  }
  return found;
}

export function isAllowedTool(name) {
  return REPO_TOOLS.has(name) || REPOLESS_TOOLS.has(name);
}

// tools/call を key の範囲で許すか。許さないときは理由を返す。
export function checkCall(call, allowedRepos) {
  if (!isAllowedTool(call.tool)) return `${call.tool} は中継で使えません`;
  const targetArg = Object.keys(call.args ?? {}).find((name) => TARGET_ARGS.has(name));
  if (targetArg) return `引数 ${targetArg} は使えません`;
  const repos = reposInArgs(call.args);
  if (repos.length === 0) {
    return REPOLESS_TOOLS.has(call.tool) ? null : 'owner と repo が要ります';
  }
  const denied = repos.find((r) => !allowedRepos.includes(r));
  return denied ? `${denied} はこの key で許可されていません` : null;
}

// 通さないメソッドを含むなら、その最初のメッセージを返す。method の無いもの（サーバーへの応答）は通す。
export function deniedMethod(message) {
  const list = Array.isArray(message) ? message : [message];
  return list.find((msg) => {
    const method = msg?.method;
    if (method === undefined) return false;
    return !(ALLOWED_METHODS.has(method) || String(method).startsWith('notifications/'));
  });
}

// JSON-RPC のメッセージ（単体または配列）から tools/call の gh_mcp_relay_key を取り出し、
// 転送前に引数から消す。
export function stripKey(message) {
  const list = Array.isArray(message) ? message : [message];
  const calls = [];
  const out = list.map((msg) => {
    if (!msg || msg.method !== 'tools/call') return msg;
    const args = { ...(msg.params?.arguments ?? {}) };
    const key = args[KEY_ARG];
    delete args[KEY_ARG];
    calls.push({ id: msg.id, tool: msg.params?.name, key, args });
    return { ...msg, params: { ...msg.params, arguments: args } };
  });
  return { message: Array.isArray(message) ? out : out[0], calls };
}

export function hasMethod(message, method) {
  const list = Array.isArray(message) ? message : [message];
  return list.some((msg) => msg && msg.method === method);
}

const KEY_PROPERTY = {
  type: 'string',
  description: 'セッションの開始時に示された gh-mcp-relay の key（GH_MCP_RELAY_KEY）。どのツールでも必須。',
};

// tools/list の結果から使えないツールを外し、残りの各ツールに gh_mcp_relay_key 引数を足す。
// Claude が使えないツールを呼んだり、引数を渡し忘れたりしないようにするため。
function injectIntoResult(msg) {
  const tools = msg?.result?.tools;
  if (!Array.isArray(tools)) return msg;
  const patched = tools.filter((tool) => isAllowedTool(tool.name)).map((tool) => {
    const schema = tool.inputSchema ?? { type: 'object' };
    const required = new Set(schema.required ?? []);
    required.add(KEY_ARG);
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties ?? {}), [KEY_ARG]: KEY_PROPERTY },
        required: [...required],
      },
    };
  });
  return { ...msg, result: { ...msg.result, tools: patched } };
}

export function injectKeyParam(bodyText, contentType) {
  if ((contentType ?? '').includes('text/event-stream')) {
    return bodyText
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        try {
          return `data: ${JSON.stringify(injectIntoResult(JSON.parse(line.slice(5))))}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }
  const parsed = JSON.parse(bodyText);
  const patched = Array.isArray(parsed) ? parsed.map(injectIntoResult) : injectIntoResult(parsed);
  return JSON.stringify(patched);
}
