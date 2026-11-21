import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { Upstream } from '../src/upstream.ts';

/** A bare Streamable HTTP server whose sessions all vanish when `restart` is called, like a remote server redeployed. */
async function forgetfulServer(options: { noPing?: boolean } = {}) {
  let generation = 1;
  let initializations = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(req.method === 'DELETE' ? 200 : 405).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as { id?: number; method: string };
    const session = `s${generation}`;
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') {
      initializations++;
      return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'forgetful', version: '1.0.0' } }, { 'mcp-session-id': session });
    }
    if (req.headers['mcp-session-id'] !== session) {
      return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Invalid MCP session id' } }));
    }
    if (message.id === undefined) return res.writeHead(202).end();
    if (message.method === 'tools/list') return reply({ tools: [] });
    if (message.method === 'ping' && options.noPing) {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ping' } }));
    }
    return reply({});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    restart: () => generation++,
    initializations: () => initializations,
    close: () => server.close(),
  };
}

test('an upstream that lost our session reconnects instead of failing every call', async (t) => {
  const remote = await forgetfulServer();
  t.after(remote.close);
  const upstream = new Upstream('remote', parseConfig(`servers:\n  remote: { url: "${remote.url}" }`).remote!, () => {});
  t.after(() => upstream.stop());
  upstream.start();
  for (let i = 0; i < 50 && upstream.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(upstream.state, 'ready');
  await upstream.ping();

  remote.restart();
  await upstream.ping();
  assert.equal(upstream.state, 'ready');
  assert.equal(remote.initializations(), 2, 'a new session was opened');
});

test('a server that does not implement ping still counts as answering', async (t) => {
  const remote = await forgetfulServer({ noPing: true });
  t.after(remote.close);
  const upstream = new Upstream('remote', parseConfig(`servers:\n  remote: { url: "${remote.url}" }`).remote!, () => {});
  t.after(() => upstream.stop());
  upstream.start();
  for (let i = 0; i < 50 && upstream.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(typeof (await upstream.ping()), 'number');
});
