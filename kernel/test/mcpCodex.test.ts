import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpCodexDriver, MCP_TOOL_GUIDANCE } from '../src/drivers/mcpCodex.js';
import { FlotaMcpServer, type McpNodeContext } from '../src/mcp/server.js';
import type { KernelApi } from '../src/tools/coordination.js';
import type { TurnInput } from '../src/driver.js';

const FIXTURE_ARGV = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.sh');
const FIXTURE_MCP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-mcp.mjs');

function readLog(logFile: string): string[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function setReplyEvents(replyFile: string, events: object[]) {
  writeFileSync(replyFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function turnInput(newText: string, system = 'You are captain.'): TurnInput {
  return { system, newText, transcript: [], tools: {} as any, maxSteps: 12, abortSignal: new AbortController().signal };
}

function setupArgvOnly() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-mcpcodex-'));
  const logFile = join(workspaceDir, 'log.jsonl');
  const replyFile = join(workspaceDir, 'reply.jsonl');
  writeFileSync(logFile, '');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_REPLY = replyFile;
  return { workspaceDir, logFile, replyFile };
}

const MCP_URL = 'http://127.0.0.1:9/mcp';
const TOKEN = 'test-token-abc';

describe('McpCodexDriver — argv/CODEX_HOME wiring (stub: fake-codex.sh)', () => {
  beforeEach(() => {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_REPLY;
  });

  it('first turn: exact argv with -c mcp flags (approve mode), --sandbox, --cd; env carries CODEX_HOME + token; config.toml marks the workspace trusted', async () => {
    const { workspaceDir, logFile, replyFile } = setupArgvOnly();
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: 'ok' }]);
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });

    const out = await driver.turn(turnInput('do the thing'));

    const [args] = readLog(logFile);
    const expectedPrompt = `[role charter]\nYou are captain.\n\n${MCP_TOOL_GUIDANCE}\n\ndo the thing`;
    expect(args).toEqual([
      'exec', expectedPrompt,
      '-c', `mcp_servers.flota.url="${MCP_URL}"`,
      '-c', 'mcp_servers.flota.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.flota.bearer_token_env_var="FLOTA_MCP_TOKEN"',
      '--json', '--sandbox', 'workspace-write', '--cd', workspaceDir,
    ]);
    expect(out).toEqual({ text: 'ok', responseMessages: [], usage: { inputTokens: 0, outputTokens: 0 }, billing: 'subscription' });

    const configToml = readFileSync(join(driver.codexHome, 'config.toml'), 'utf8');
    expect(configToml).toContain(`[projects."${workspaceDir}"]`);
    expect(configToml).toContain('trust_level = "trusted"');

    driver.cleanup();
  });

  it('resume turn: exact argv with resume subcommand + same -c flags, no --cd/--sandbox, no charter', async () => {
    const { workspaceDir, logFile, replyFile } = setupArgvOnly();
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });

    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-abc' }, { type: 'agent_message', text: 'first' }]);
    await driver.turn(turnInput('turn one'));

    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'second' }]);
    await driver.turn(turnInput('turn two'));

    const [, args2] = readLog(logFile);
    expect(args2).toEqual([
      'exec', 'resume', 'sess-abc', 'turn two',
      '-c', `mcp_servers.flota.url="${MCP_URL}"`,
      '-c', 'mcp_servers.flota.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.flota.bearer_token_env_var="FLOTA_MCP_TOKEN"',
      '--json',
    ]);
    expect(args2).not.toContain('--cd');
    expect(args2).not.toContain('--sandbox');
    expect(args2).not.toContain('[role charter]');

    driver.cleanup();
  });

  it('cleanup() removes the temp CODEX_HOME directory', async () => {
    const { workspaceDir, replyFile } = setupArgvOnly();
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: 'ok' }]);
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });
    await driver.turn(turnInput('go'));

    expect(existsSync(driver.codexHome)).toBe(true);
    driver.cleanup();
    expect(existsSync(driver.codexHome)).toBe(false);
  });

  it('throws on empty/unusable output instead of returning a silent empty success', async () => {
    const { workspaceDir, replyFile } = setupArgvOnly();
    writeFileSync(replyFile, '');
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });

    await expect(driver.turn(turnInput('go'))).rejects.toThrow();
    driver.cleanup();
  });

  it('throws when every agent_message event carries empty text', async () => {
    const { workspaceDir, replyFile } = setupArgvOnly();
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: '' }]);
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });

    await expect(driver.turn(turnInput('go'))).rejects.toThrow('empty turn text from codex output');
    driver.cleanup();
  });

  it('logs mcp_tool_call item.started/item.completed events to console.error for observability', async () => {
    const { workspaceDir, replyFile } = setupArgvOnly();
    setReplyEvents(replyFile, [
      { type: 'session_started', session_id: 'sess-1' },
      { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'flota', tool: 'report', arguments: { text: 'hi' }, result: null, error: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'flota', tool: 'report', arguments: { text: 'hi' }, result: { content: [{ type: 'text', text: 'reported' }] }, error: null, status: 'completed' } },
      { type: 'agent_message', text: 'done' },
    ]);
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: MCP_URL, token: TOKEN, bin: FIXTURE_ARGV });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await driver.turn(turnInput('go'));

    expect(out.text).toBe('done');
    const calls = spy.mock.calls.map(c => c.join(' '));
    expect(calls.some(c => c.includes('tool_call started') && c.includes('flota.report'))).toBe(true);
    expect(calls.some(c => c.includes('tool_call completed') && c.includes('flota.report'))).toBe(true);

    spy.mockRestore();
    driver.cleanup();
  });
});

describe('McpCodexDriver — real MCP round-trip (stub: fake-codex-mcp.mjs -> real FlotaMcpServer)', () => {
  let server: FlotaMcpServer;
  let url: string;

  beforeEach(async () => {
    delete process.env.FAKE_CLI_LOG;
    server = new FlotaMcpServer();
    ({ url } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('spawns codex against a real FlotaMcpServer: delegate fires for real, tool events observed, final text + session parsed, approve/bearer wiring proven end-to-end', async () => {
    const api: KernelApi & { delegate: ReturnType<typeof vi.fn>; emitMessage: ReturnType<typeof vi.fn> } = {
      delegate: vi.fn().mockReturnValue('spawned crew-1 (task t2)'),
      emitMessage: vi.fn(),
    } as any;
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-mcpcodex-real-'));
    const logFile = join(workspaceDir, 'argv-log.jsonl');
    writeFileSync(logFile, '');
    process.env.FAKE_CLI_LOG = logFile;

    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: url, token, bin: FIXTURE_MCP });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await driver.turn(turnInput('delegate the scan', 'You are captain.'));

    // The real KernelApi.delegate fired, called through the actual MCP wire —
    // not a text-block parse — proving the codex-agent-calls-real-tool path.
    expect(api.delegate).toHaveBeenCalledWith('captain', { role: 'x', charter: 'y', task: 'z' });

    // Final agent_message text carries the real delegate result through.
    expect(out.text).toBe('Delegated: spawned crew-1 (task t2)');
    expect(out.responseMessages).toEqual([]);
    expect(out.billing).toBe('subscription');

    // Tool-call observability logging fired for the real round-tripped call.
    const calls = spy.mock.calls.map(c => c.join(' '));
    expect(calls.some(c => c.includes('tool_call started') && c.includes('flota.delegate'))).toBe(true);
    expect(calls.some(c => c.includes('tool_call completed') && c.includes('flota.delegate'))).toBe(true);

    // The exact argv codex received: approve mode + bearer env var + real url.
    const [args1] = readLog(logFile);
    expect(args1[0]).toBe('exec');
    expect(args1).toContain('-c');
    expect(args1).toContain('mcp_servers.flota.default_tools_approval_mode="approve"');
    expect(args1).toContain('mcp_servers.flota.bearer_token_env_var="FLOTA_MCP_TOKEN"');
    expect(args1).toContain(`mcp_servers.flota.url="${url}"`);

    // CODEX_HOME trust wiring proven for this exact workspaceDir.
    const configToml = readFileSync(join(driver.codexHome, 'config.toml'), 'utf8');
    expect(configToml).toContain(`[projects."${workspaceDir}"]`);
    expect(configToml).toContain('trust_level = "trusted"');

    // Session id was actually parsed (not just present in the stub's output):
    // a second turn resumes it, real-round-tripping delegate again through the
    // same MCP server via the resumed session's argv shape.
    const out2 = await driver.turn(turnInput('delegate again'));
    expect(out2.text).toBe('Delegated: spawned crew-1 (task t2)');
    const [, args2] = readLog(logFile);
    expect(args2.slice(0, 3)).toEqual(['exec', 'resume', 'sess-stub-mcp-1']);
    expect(args2).not.toContain('--cd');
    expect(args2).not.toContain('--sandbox');

    spy.mockRestore();
    driver.cleanup();
  });

  it('an unknown/wrong bearer token gets 401 from the real server and the driver surfaces a rejection', async () => {
    const api: KernelApi & { delegate: ReturnType<typeof vi.fn>; emitMessage: ReturnType<typeof vi.fn> } = {
      delegate: vi.fn(),
      emitMessage: vi.fn(),
    } as any;
    server.registerNode({ nodeId: 'captain', role: 'captain', api, taskId: 't1' });

    const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-mcpcodex-badtoken-'));
    const driver = new McpCodexDriver({ workspaceDir, mcpUrl: url, token: 'not-the-real-token', bin: FIXTURE_MCP });

    await expect(driver.turn(turnInput('go'))).rejects.toThrow();
    expect(api.delegate).not.toHaveBeenCalled();

    driver.cleanup();
  });
});
