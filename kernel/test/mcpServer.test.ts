import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FlotaMcpServer, type McpNodeContext } from '../src/mcp/server.js';
import type { KernelApi } from '../src/tools/coordination.js';

function fakeApi(): KernelApi & { delegate: ReturnType<typeof vi.fn>; emitMessage: ReturnType<typeof vi.fn> } {
  return {
    delegate: vi.fn().mockReturnValue('spawned crew-1 (task t2)'),
    emitMessage: vi.fn(),
  } as any;
}

async function connectedClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (first && first.type === 'text' && typeof first.text === 'string') return first.text;
  throw new Error('expected text content');
}

describe('FlotaMcpServer', () => {
  let server: FlotaMcpServer;
  let url: string;

  beforeEach(async () => {
    server = new FlotaMcpServer();
    ({ url } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('captain token: delegate calls KernelApi.delegate and returns its string', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'delegate', arguments: { role: 'x', charter: 'y', task: 'z' } });

    expect(api.delegate).toHaveBeenCalledWith('captain', { role: 'x', charter: 'y', task: 'z' });
    expect(textOf(result)).toBe('spawned crew-1 (task t2)');
    await client.close();
  });

  it('captain token: report is role-gated, emitMessage not called', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'report', arguments: { text: 'hi' } });

    expect(textOf(result)).toBe('error: report is not available to this role');
    expect(api.emitMessage).not.toHaveBeenCalled();
    await client.close();
  });

  it('crew token: report emits REPORT addressed to captain', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'report', arguments: { text: 'progress update' } });

    expect(textOf(result)).toBe('reported');
    expect(api.emitMessage).toHaveBeenCalledWith({ kind: 'REPORT', from: 'crew-1', to: 'captain', taskId: 't2', text: 'progress update' });
    await client.close();
  });

  it('crew token: delegate is role-gated, KernelApi.delegate not called', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'delegate', arguments: { role: 'x', charter: 'y', task: 'z' } });

    expect(textOf(result)).toBe('error: delegate is not available to this role');
    expect(api.delegate).not.toHaveBeenCalled();
    await client.close();
  });

  it('crew token: answer is role-gated', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'answer', arguments: { taskId: 't2', text: 'nope' } });

    expect(textOf(result)).toBe('error: answer is not available to this role');
    expect(api.emitMessage).not.toHaveBeenCalled();
    await client.close();
  });

  it('crew token: deliver and escalate address the captain', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    await client.callTool({ name: 'deliver', arguments: { text: 'final result' } });
    await client.callTool({ name: 'escalate', arguments: { question: 'which scope?' } });

    expect(api.emitMessage).toHaveBeenNthCalledWith(1, { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'final result' });
    expect(api.emitMessage).toHaveBeenNthCalledWith(2, { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'which scope?' });
    await client.close();
  });

  it('captain token: answer emits ANSWER targeting the escalating task', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'answer', arguments: { taskId: 't2', text: 'include both' } });

    expect(textOf(result)).toBe('answered');
    expect(api.emitMessage).toHaveBeenCalledWith({ kind: 'ANSWER', from: 'captain', to: '', taskId: 't2', text: 'include both' });
    await client.close();
  });

  it('captain token: deliver and escalate address the operator', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const client = await connectedClient(url, token);
    await client.callTool({ name: 'deliver', arguments: { text: 'mission result' } });
    await client.callTool({ name: 'escalate', arguments: { question: 'confirm scope?' } });

    expect(api.emitMessage).toHaveBeenNthCalledWith(1, { kind: 'DELIVER', from: 'captain', to: 'operator', taskId: 't1', text: 'mission result' });
    expect(api.emitMessage).toHaveBeenNthCalledWith(2, { kind: 'ESCALATE', from: 'captain', to: 'operator', taskId: 't1', text: 'confirm scope?' });
    await client.close();
  });

  it('unknown token gets 401', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } } }),
    });
    expect(res.status).toBe(401);
  });

  it('absent token gets 401', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } } }),
    });
    expect(res.status).toBe(401);
  });

  it('present-but-malformed Authorization gets 401', async () => {
    const bodyInit = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } } });
    const basic = await fetch(url, { method: 'POST', headers: { ...bodyInit, authorization: 'Basic xyz' }, body: initBody });
    const bare = await fetch(url, { method: 'POST', headers: { ...bodyInit, authorization: 'Bearer' }, body: initBody });
    expect(basic.status).toBe(401);
    expect(bare.status).toBe(401);
  });

  it('deliver carries a >100kb payload without a 413 (body limit)', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);
    const bigText = 'x'.repeat(200 * 1024); // 200kb — over express.json's 100kb default

    const client = await connectedClient(url, token);
    const result = await client.callTool({ name: 'deliver', arguments: { text: bigText } });

    expect(textOf(result)).toBe('delivered');
    expect(api.emitMessage).toHaveBeenCalledWith({ kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: bigText });
    await client.close();
  });

  it('survives client-disconnect races without crashing the process', async () => {
    // The write-after-disconnect rejection the POST handler's try/catch guards
    // against is not synchronously inducible (the SDK+node stack handles aborts
    // gracefully here). This asserts the behavioral invariant instead: a burst
    // of aborted requests must leave the server up, serving the next request,
    // with no unhandled rejection escaping to crash the in-process kernel.
    const api = fakeApi();
    const token = server.registerNode({ nodeId: 'crew-1', role: 'crew', api, taskId: 't2' });
    let unhandled = 0;
    const onRejection = () => { unhandled++; };
    process.on('unhandledRejection', onRejection);
    try {
      for (let i = 0; i < 20; i++) {
        const ac = new AbortController();
        const p = fetch(url, {
          method: 'POST', signal: ac.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } } }),
        }).catch(() => undefined);
        setTimeout(() => ac.abort(), Math.random() * 3);
        await p;
      }
      await new Promise((r) => setTimeout(r, 50));
      const client = await connectedClient(url, token);
      const result = await client.callTool({ name: 'report', arguments: { text: 'still alive' } });
      expect(textOf(result)).toBe('reported');
      await client.close();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(unhandled).toBe(0);
  });

  it('unregisterNode revokes the token', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);
    server.unregisterNode('crew-1');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } } }),
    });
    expect(res.status).toBe(401);
  });
});
