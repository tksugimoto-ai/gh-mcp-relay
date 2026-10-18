// GitHub MCP 用の薄い中継。
// - 認可（OAuth）は Claude のコネクタと GitHub に任せ、token を保存しない。
// - 確認するのは パス・token の持ち主・環境ごとの key だけ。repo の範囲は GitHub App の installation 先で決まる。

import {
  hasMethod,
  injectKeyParam,
  isActive,
  keyMatches,
  matchRoute,
  parseConfig,
  resourceMetadata,
  sha256Hex,
  stripKey,
} from './lib.js';

const FORWARD_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];
const LOGIN_CACHE_MS = 5 * 60 * 1000;

// isolate ごとのキャッシュ。キーは token のハッシュで、token 自体は持たない。
const loginCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    if (!route) return text(404, 'not found');

    let config;
    try {
      config = parseConfig(env.PATHS_JSON ?? '');
    } catch (e) {
      console.error('config error', e.message);
      return text(500, 'misconfigured');
    }
    const entry = config.paths[route.name];
    if (!entry || !isActive(entry, Date.now())) return text(404, 'not found');

    if (route.kind === 'metadata') return json(200, resourceMetadata(url.origin, route.name));

    const auth = request.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!token) return unauthorized(url.origin, route.name);

    const login = await resolveLogin(token);
    if (!login) return unauthorized(url.origin, route.name);
    if (!entry.allowed_logins.includes(login)) {
      log(route.name, request.method, '-', 'login-denied');
      return text(403, 'login not allowed');
    }

    let body;
    let isToolsList = false;
    if (request.method === 'POST') {
      let message;
      try {
        message = JSON.parse(await request.text());
      } catch {
        return json(400, rpcError(null, -32700, 'parse error'));
      }
      const { message: stripped, calls } = stripKey(message);
      for (const call of calls) {
        if (!(await keyMatches(call.key, entry.key_sha256))) {
          log(route.name, 'tools/call', call.tool, 'key-denied');
          return json(200, rpcError(call.id, -32001, 'upstream_key が無いか、この環境のものではありません'));
        }
      }
      for (const call of calls) log(route.name, 'tools/call', call.tool, 'forward');
      isToolsList = hasMethod(message, 'tools/list');
      body = JSON.stringify(stripped);
    }

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(entry.upstream, { method: request.method, headers, body });

    if (upstream.status === 401) return unauthorized(url.origin, route.name);

    const responseHeaders = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    if (isToolsList && upstream.ok) {
      const patched = injectKeyParam(await upstream.text(), upstream.headers.get('content-type'));
      return new Response(patched, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};

async function resolveLogin(token) {
  const cacheKey = await sha256Hex(token);
  const hit = loginCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.login;

  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'gh-mcp-relay' },
  });
  if (!res.ok) return null;
  const { login } = await res.json();
  loginCache.set(cacheKey, { login, expiresAt: Date.now() + LOGIN_CACHE_MS });
  return login;
}

function unauthorized(origin, name) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/e/${name}/mcp`;
  return new Response('unauthorized', {
    status: 401,
    headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function text(status, value) {
  return new Response(value, { status });
}

// token・ヘッダー・key は残さない。
function log(path, method, tool, result) {
  console.log(JSON.stringify({ path, method, tool, result }));
}
