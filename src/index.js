// GitHub MCP 用の薄い中継。
// - 認可（OAuth）は Claude のコネクタと GitHub に任せ、token は確かめずにそのまま転送する。保存もしない。
// - 確かめるのは、ツール呼び出しの upstream_key と、その key が許す repo だけ。
// - 転送先はパスに書く（`/[<ラベル>/]<https:// を除いた公式 GitHub MCP の URL>`）。中継は設定ファイルを持たない。

import { checkCall, hasMethod, injectKeyParam, matchRoute, parseHosts, resourceMetadata, stripKey, verifyKey } from './lib.js';

const FORWARD_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname, parseHosts(env.UPSTREAM_HOSTS));
    if (!route) return text(404, 'not found');
    if (!env.KEY_SECRET) {
      console.error('KEY_SECRET is not set');
      return text(500, 'misconfigured');
    }

    if (route.kind === 'metadata') return json(200, resourceMetadata(url.origin, route.path));

    // token の中身は確かめない。無いときだけ、Claude に OAuth を始めさせるために 401 を返す。
    if (!/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) {
      return unauthorized(url.origin, route.path);
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
        const key = await verifyKey(env.KEY_SECRET, call.key, Date.now());
        const reason = key ? checkCall(call, key.repos) : 'upstream_key が無いか、正しくありません';
        if (reason) {
          log(route.path, call.tool, 'denied');
          return json(200, rpcError(call.id, -32001, reason));
        }
      }
      for (const call of calls) log(route.path, call.tool, 'forward');
      isToolsList = hasMethod(message, 'tools/list');
      body = JSON.stringify(stripped);
    }

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(route.upstream, { method: request.method, headers, body });

    if (upstream.status === 401) return unauthorized(url.origin, route.path);

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

function unauthorized(origin, path) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/${path}`;
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
function log(path, tool, result) {
  console.log(JSON.stringify({ path, tool, result }));
}
