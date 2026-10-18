// 中継の判定ロジック。Workers と Node（テスト）の両方で動くよう、Web 標準 API だけを使う。

export const KEY_ARG = 'upstream_key';

const ENDPOINT_RE = /^\/e\/([A-Za-z0-9_-]{1,64})\/mcp\/?$/;
const METADATA_RE = /^\/\.well-known\/oauth-protected-resource\/e\/([A-Za-z0-9_-]{1,64})\/mcp\/?$/;

// URL のパスから、どのパス設定を使うかを決める。
export function matchRoute(pathname) {
  let m = ENDPOINT_RE.exec(pathname);
  if (m) return { kind: 'endpoint', name: m[1] };
  m = METADATA_RE.exec(pathname);
  if (m) return { kind: 'metadata', name: m[1] };
  return null;
}

// 環境変数 PATHS_JSON を読み、形を検証する。不正なら例外。
export function parseConfig(text) {
  const config = JSON.parse(text);
  if (!config || typeof config.paths !== 'object') throw new Error('PATHS_JSON: "paths" がない');
  for (const [name, entry] of Object.entries(config.paths)) {
    if (!/^[0-9a-f]{64}$/.test(entry.key_sha256 ?? '')) throw new Error(`${name}: key_sha256 が不正`);
    if (!Array.isArray(entry.allowed_logins) || entry.allowed_logins.length === 0) {
      throw new Error(`${name}: allowed_logins が空`);
    }
    const upstream = new URL(entry.upstream);
    if (upstream.protocol !== 'https:') throw new Error(`${name}: upstream は https のみ`);
  }
  return config;
}

export function isActive(entry, now) {
  if (entry.enabled === false) return false;
  if (entry.expires && now >= Date.parse(entry.expires)) return false;
  return true;
}

export function resourceMetadata(origin, name) {
  return {
    resource: `${origin}/e/${name}/mcp`,
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
  };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 長さが同じ16進文字列どうしを、内容によらず同じ時間で比べる。
export function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function keyMatches(key, keySha256) {
  if (typeof key !== 'string' || key.length === 0) return false;
  return timingSafeEqualHex(await sha256Hex(key), keySha256);
}

// JSON-RPC のメッセージ（単体または配列）から tools/call の upstream_key を取り出し、
// 転送前に引数から消す。中身の解析はこの1点だけに限る。
export function stripKey(message) {
  const list = Array.isArray(message) ? message : [message];
  const calls = [];
  const out = list.map((msg) => {
    if (!msg || msg.method !== 'tools/call') return msg;
    const args = { ...(msg.params?.arguments ?? {}) };
    const key = args[KEY_ARG];
    delete args[KEY_ARG];
    calls.push({ id: msg.id, tool: msg.params?.name, key });
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
  description: '環境の UPSTREAM_KEY の値（~/.claude/CLAUDE.md に記載）。どのツールでも必須。',
};

// tools/list の結果の各ツールに upstream_key 引数を足す。Claude が引数を渡し忘れないようにするため。
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
