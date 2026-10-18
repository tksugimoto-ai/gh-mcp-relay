import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KEY_ARG,
  injectKeyParam,
  isActive,
  keyMatches,
  matchRoute,
  parseConfig,
  resourceMetadata,
  sha256Hex,
  stripKey,
} from '../src/lib.js';

const KEY = 'k_test_key';
const validEntry = async () => ({
  key_sha256: await sha256Hex(KEY),
  allowed_logins: ['tksugimoto-ai'],
  upstream: 'https://api.githubcopilot.com/mcp/x/issues,pull_requests',
});

test('matchRoute: エンドポイントとメタデータを見分ける', () => {
  assert.deepEqual(matchRoute('/e/pocket-ssh-agent/mcp'), { kind: 'endpoint', name: 'pocket-ssh-agent' });
  assert.deepEqual(matchRoute('/.well-known/oauth-protected-resource/e/pocket-ssh-agent/mcp'), {
    kind: 'metadata',
    name: 'pocket-ssh-agent',
  });
  assert.equal(matchRoute('/e/../mcp'), null);
  assert.equal(matchRoute('/e/a/b/mcp'), null);
  assert.equal(matchRoute('/'), null);
});

test('parseConfig: 不正な設定を拒否する', async () => {
  const entry = await validEntry();
  assert.ok(parseConfig(JSON.stringify({ paths: { a: entry } })));
  assert.throws(() => parseConfig(JSON.stringify({ paths: { a: { ...entry, key_sha256: 'x' } } })));
  assert.throws(() => parseConfig(JSON.stringify({ paths: { a: { ...entry, allowed_logins: [] } } })));
  assert.throws(() => parseConfig(JSON.stringify({ paths: { a: { ...entry, upstream: 'http://example.com' } } })));
  assert.throws(() => parseConfig('{}'));
});

test('isActive: enabled と expires を見る', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  assert.equal(isActive({}, now), true);
  assert.equal(isActive({ enabled: false }, now), false);
  assert.equal(isActive({ expires: '2026-10-16' }, now), false);
  assert.equal(isActive({ expires: '2027-01-01' }, now), true);
});

test('resourceMetadata: GitHub を認可サーバーとして返す', () => {
  assert.deepEqual(resourceMetadata('https://relay.example.com', 'x'), {
    resource: 'https://relay.example.com/e/x/mcp',
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
  });
});

test('keyMatches: 正しい key だけ通す', async () => {
  const { key_sha256 } = await validEntry();
  assert.equal(await keyMatches(KEY, key_sha256), true);
  assert.equal(await keyMatches('k_other', key_sha256), false);
  assert.equal(await keyMatches(undefined, key_sha256), false);
  assert.equal(await keyMatches('', key_sha256), false);
});

test('stripKey: tools/call の key を取り出して引数から消す', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: { [KEY_ARG]: KEY, a: 1 } } };
  const { message, calls } = stripKey(msg);
  assert.deepEqual(message.params.arguments, { a: 1 });
  assert.deepEqual(calls, [{ id: 1, tool: 'get_me', key: KEY }]);
  assert.equal(msg.params.arguments[KEY_ARG], KEY, '元のメッセージは変えない');
});

test('stripKey: tools/call 以外と配列', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
  ];
  const { message, calls } = stripKey(batch);
  assert.deepEqual(message[0], batch[0]);
  assert.deepEqual(message[1].params.arguments, {});
  assert.deepEqual(calls, [{ id: 2, tool: 'x', key: undefined }]);
});

test('injectKeyParam: JSON と SSE の両方で引数を足す', () => {
  const result = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_me', inputSchema: { type: 'object', required: ['a'] } }] } };
  const fromJson = JSON.parse(injectKeyParam(JSON.stringify(result), 'application/json'));
  assert.deepEqual(fromJson.result.tools[0].inputSchema.required, ['a', KEY_ARG]);
  assert.ok(fromJson.result.tools[0].inputSchema.properties[KEY_ARG]);

  const sse = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
  const line = injectKeyParam(sse, 'text/event-stream').split('\n')[1];
  assert.ok(JSON.parse(line.slice(5)).result.tools[0].inputSchema.properties[KEY_ARG]);
});
