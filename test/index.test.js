import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import worker from '../src/index.js';
import { KEY_ARG, sha256Hex } from '../src/lib.js';

const KEY = 'k_test_key';
const UPSTREAM = 'https://upstream.example.com/mcp';
const env = async () => ({
  PATHS_JSON: JSON.stringify({
    paths: { pocket: { key_sha256: await sha256Hex(KEY), allowed_logins: ['tksugimoto-ai'], upstream: UPSTREAM } },
  }),
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// GitHub の /user と転送先を差し替える。転送されたリクエストは forwarded に残す。
function stubFetch({ login = 'tksugimoto-ai', upstream } = {}) {
  const forwarded = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://api.github.com/user') {
      return login ? Response.json({ login }) : new Response('bad', { status: 401 });
    }
    if (url === UPSTREAM) {
      forwarded.push({ method: init.method, headers: init.headers, body: init.body });
      return upstream ? upstream(init) : Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return forwarded;
}

const call = (body, token = `tok-${Math.random()}`) =>
  new Request('https://relay.example.com/e/pocket/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const toolCall = (args) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'issue_write', arguments: args } });

test('メタデータは token なしで返す', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/.well-known/oauth-protected-resource/e/pocket/mcp'), await env());
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).authorization_servers, ['https://github.com/login/oauth']);
});

test('token なしは 401 とメタデータの場所', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/e/pocket/mcp', { method: 'POST', body: '{}' }), await env());
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /oauth-protected-resource\/e\/pocket\/mcp/);
});

test('知らないパスは 404', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/e/other/mcp', { method: 'POST' }), await env());
  assert.equal(res.status, 404);
});

test('許可していない login は 403', async () => {
  const forwarded = stubFetch({ login: 'someone-else' });
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY })), await env());
  assert.equal(res.status, 403);
  assert.equal(forwarded.length, 0);
});

test('key が違う tools/call は転送しない', async () => {
  const forwarded = stubFetch();
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: 'k_wrong', title: 'x' })), await env());
  assert.equal((await res.json()).error.code, -32001);
  assert.equal(forwarded.length, 0);
});

test('正しい key なら key を消して転送する', async () => {
  const forwarded = stubFetch();
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY, title: 'x' })), await env());
  assert.equal(res.status, 200);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(JSON.parse(forwarded[0].body).params.arguments, { title: 'x' });
  assert.match(forwarded[0].headers.get('authorization'), /^Bearer tok-/);
});

test('tools/list の結果に upstream_key を足す', async () => {
  stubFetch({
    upstream: () => Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_me', inputSchema: { type: 'object' } }] } }),
  });
  const res = await worker.fetch(call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), await env());
  const tool = (await res.json()).result.tools[0];
  assert.deepEqual(tool.inputSchema.required, [KEY_ARG]);
});
