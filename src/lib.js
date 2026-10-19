// 中継の判定ロジック。Workers と Node（テスト）の両方で動くよう、Web 標準 API だけを使う。

export const KEY_ARG = 'gh_mcp_relay_key';
// 転送先。コネクタの URL は、公式 GitHub MCP の URL のホスト部分だけを中継のものに置き換えたもの。
export const UPSTREAM_ORIGIN = 'https://api.githubcopilot.com';

const KEY_PREFIX = 'gh-mcp-relay';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;
const METADATA_PREFIX = '/.well-known/oauth-protected-resource/';
// 転送してよいパス。公式 GitHub MCP の `/mcp` 以下だけで、`..` は別に弾く。
const UPSTREAM_PATH_RE = /^\/mcp(\/[A-Za-z0-9._,-]+)*\/?$/;

// owner/repo を取らないが、どの repo にも届かないので許すツール。
const REPOLESS_TOOLS = new Set(['get_me']);
// owner だけを取り、アカウントや org 全体に効くツール（Projects）。repo を足されても上流は無視するので、
// 引数によらず使わせない。
const OWNER_SCOPED_TOOL_RE = /project/;
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
  if (!UPSTREAM_PATH_RE.test(path) || path.split('/').includes('..')) return null;
  return { kind, path, upstream: `${UPSTREAM_ORIGIN}${path}` };
}

// OAuth App で認可するときに求める scope。OAuth App の token は求めた scope しか持たないので、
// private の repo を読むには repo が要る。OAuth App のコネクタは readonly のパスで登録する
// （同じ URL のコネクタは 2 つ登録できない）ので、readonly のパスでだけ返す。GitHub App は scope を見ない。
export function oauthScope(path) {
  return path.split('/').includes('readonly') ? 'repo' : null;
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

// tools/call を key の範囲で許すか。許さないときは理由を返す。
export function checkCall(call, allowedRepos) {
  // search_* は owner/repo を省略でき、クエリでほかの repo にも届きうるので、引数によらず使わせない。
  if (String(call.tool).startsWith('search_')) return 'search_* のツールは使えません';
  if (OWNER_SCOPED_TOOL_RE.test(call.tool)) return 'Projects のツールは使えません';
  const repos = reposInArgs(call.args);
  if (repos.length === 0) {
    return REPOLESS_TOOLS.has(call.tool) ? null : 'owner と repo を取らないツールは使えません';
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

// tools/list の結果の各ツールに gh_mcp_relay_key 引数を足す。Claude が引数を渡し忘れないようにするため。
function injectIntoResult(msg) {
  const tools = msg?.result?.tools;
  if (!Array.isArray(tools)) return msg;
  const patched = tools.map((tool) => {
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
