import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KEY_ARG,
  checkCall,
  createKey,
  injectKeyParam,
  matchRoute,
  parseHosts,
  reposInArgs,
  resourceMetadata,
  stripKey,
  verifyKey,
} from '../src/lib.js';

const SECRET = 'test-secret';
const NOW = Date.parse('2026-10-18T00:00:00Z');

test('matchRoute: パスから転送先を決める', () => {
  assert.deepEqual(matchRoute('/api.githubcopilot.com/mcp/x/issues,pull_requests'), {
    kind: 'endpoint',
    path: 'api.githubcopilot.com/mcp/x/issues,pull_requests',
    upstream: 'https://api.githubcopilot.com/mcp/x/issues,pull_requests',
  });
  assert.deepEqual(matchRoute('/org-app/api.githubcopilot.com/mcp/'), {
    kind: 'endpoint',
    path: 'org-app/api.githubcopilot.com/mcp/',
    upstream: 'https://api.githubcopilot.com/mcp/',
  });
  assert.equal(matchRoute('/.well-known/oauth-protected-resource/api.githubcopilot.com/mcp/').kind, 'metadata');
});

test('matchRoute: 許可していないホストや怪しいパスは拒否する', () => {
  assert.equal(matchRoute('/evil.example.com/mcp'), null);
  assert.equal(matchRoute('/api.githubcopilot.com/../mcp'), null);
  assert.equal(matchRoute('/api.githubcopilot.com/mcp?x=1'), null);
  assert.equal(matchRoute('/'), null);
  assert.equal(matchRoute('/a/b/api.githubcopilot.com/mcp'), null);
  assert.ok(matchRoute('/other.example.com/mcp', parseHosts('other.example.com')));
});

test('resourceMetadata: GitHub を認可サーバーとして返す', () => {
  assert.deepEqual(resourceMetadata('https://relay.example.com', 'api.githubcopilot.com/mcp/'), {
    resource: 'https://relay.example.com/api.githubcopilot.com/mcp/',
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
  });
});

test('createKey / verifyKey: 読める形で、署名を確かめる', async () => {
  const key = await createKey(SECRET, { repos: ['tksugimoto/pocket-ssh-agent', 'tksugimoto/Sub'] });
  assert.match(key, /^gh-mcp-relay:tksugimoto\/pocket-ssh-agent,tksugimoto\/sub:[A-Za-z0-9_-]+$/);
  assert.deepEqual((await verifyKey(SECRET, key, NOW)).repos, ['tksugimoto/pocket-ssh-agent', 'tksugimoto/sub']);
  assert.equal(await verifyKey('other-secret', key, NOW), null);
});

test('verifyKey: 書き換えた key と期限切れを拒否する', async () => {
  const key = await createKey(SECRET, { repos: ['tksugimoto/a'], expires: '2026-10-19' });
  assert.ok(await verifyKey(SECRET, key, NOW));
  assert.equal(await verifyKey(SECRET, key, Date.parse('2026-10-19T00:00:00Z')), null);
  assert.equal(await verifyKey(SECRET, key.replace('tksugimoto/a', 'tksugimoto/b'), NOW), null);
  assert.equal(await verifyKey(SECRET, key.replace('2026-10-19', '2099-01-01'), NOW), null);
  assert.equal(await verifyKey(SECRET, undefined, NOW), null);
  assert.equal(await verifyKey(SECRET, 'gh-mcp-relay:x/y:!!', NOW), null);
});

test('createKey: 不正な入力を拒否する', async () => {
  await assert.rejects(createKey(SECRET, { repos: [] }));
  await assert.rejects(createKey(SECRET, { repos: ['no-slash'] }));
  await assert.rejects(createKey(SECRET, { repos: ['a/b:c'] }));
  await assert.rejects(createKey(SECRET, { repos: ['a/b'], expires: 'tomorrow' }));
});

test('reposInArgs / checkCall: 引数の owner/repo を key の範囲で確かめる', () => {
  assert.deepEqual(reposInArgs({ owner: 'A', repo: 'B', parent_owner: 'c', parent_repo: 'd', title: 'x' }), ['a/b', 'c/d']);
  const allowed = ['tksugimoto/a'];
  assert.equal(checkCall({ tool: 'issue_write', args: { owner: 'tksugimoto', repo: 'a' } }, allowed), null);
  assert.match(checkCall({ tool: 'issue_write', args: { owner: 'tksugimoto', repo: 'b' } }, allowed), /tksugimoto\/b/);
  assert.ok(checkCall({ tool: 'issue_write', args: { owner: 'tksugimoto', repo: 'a', parent_owner: 'x', parent_repo: 'y' } }, allowed));
  assert.ok(checkCall({ tool: 'search_issues', args: { query: 'repo:x/y' } }, allowed));
  assert.equal(checkCall({ tool: 'get_me', args: {} }, allowed), null);
});

test('stripKey: tools/call の key を取り出して引数から消す', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: { [KEY_ARG]: 'k', a: 1 } } };
  const { message, calls } = stripKey(msg);
  assert.deepEqual(message.params.arguments, { a: 1 });
  assert.deepEqual(calls, [{ id: 1, tool: 'get_me', key: 'k', args: { a: 1 } }]);
  assert.equal(msg.params.arguments[KEY_ARG], 'k', '元のメッセージは変えない');
});

test('stripKey: tools/call 以外と配列', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
  ];
  const { message, calls } = stripKey(batch);
  assert.deepEqual(message[0], batch[0]);
  assert.deepEqual(message[1].params.arguments, {});
  assert.deepEqual(calls, [{ id: 2, tool: 'x', key: undefined, args: {} }]);
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
