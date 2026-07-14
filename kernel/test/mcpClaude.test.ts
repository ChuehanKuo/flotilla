import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { McpClaudeDriver, MCP_TOOL_GUIDANCE, parseMcpClaudeStdout, type McpToolEvent } from '../src/drivers/mcpClaude.js';
import { FlotaMcpServer, type McpNodeContext } from '../src/mcp/server.js';
import type { KernelApi } from '../src/tools/coordination.js';
import type { TurnInput } from '../src/driver.js';

// Real round-trip stub (unlike fake-claude.sh's canned-reply echo): reads its
// own --mcp-config, opens a real MCP client, and calls delegate for real.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-mcp.mjs');

function fakeApi(): KernelApi & { delegate: ReturnType<typeof vi.fn>; emitMessage: ReturnType<typeof vi.fn> } {
  return {
    delegate: vi.fn().mockReturnValue('spawned crew-1 (task t2)'),
    emitMessage: vi.fn(),
  } as any;
}

function readLog(logFile: string): string[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function fakeTools(): ToolSet {
  const names = ['deliver', 'report', 'escalate', 'delegate', 'answer'] as const;
  const tools: any = {};
  for (const n of names) tools[n] = { execute: vi.fn(async () => `${n}-ok`) };
  return tools as ToolSet;
}

function turnInput(newText: string, system = 'You are captain.'): TurnInput {
  return { system, newText, transcript: [], tools: fakeTools(), maxSteps: 12, abortSignal: new AbortController().signal };
}

describe('McpClaudeDriver', () => {
  let server: FlotaMcpServer;
  let url: string;
  let workspaceDir: string;
  let logFile: string;

  beforeEach(async () => {
    delete process.env.FAKE_CLI_LOG;
    server = new FlotaMcpServer();
    ({ url } = await server.start());
    workspaceDir = mkdtempSync(join(tmpdir(), 'flota-mcp-claude-'));
    logFile = join(workspaceDir, 'log.jsonl');
    writeFileSync(logFile, '');
    process.env.FAKE_CLI_LOG = logFile;
  });

  afterEach(async () => {
    await server.stop();
    delete process.env.FAKE_CLI_LOG;
  });

  it('first turn: end-to-end round-trip — driver → claude stub → MCP → kernel delegate fires', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const events: McpToolEvent[] = [];
    const driver = new McpClaudeDriver({
      workspaceDir,
      mcpUrl: url,
      token,
      bin: FIXTURE,
      onToolEvent: e => events.push(e),
    });

    const out = await driver.turn(turnInput('[TASK from operator · task t1] scan the repo'));

    // (a) the real KernelApi.delegate fired — proves driver -> claude stub ->
    // MCP server -> kernel wiring, not a mock of any intermediate layer.
    expect(api.delegate).toHaveBeenCalledWith('captain', {
      role: 'metrics-scan', charter: 'scan the repo', task: 'find dead code',
    });

    // (b) the driver logged tool_use + tool_result as observability events,
    // both via the onToolEvent callback and the toolEvents getter.
    expect(events).toEqual([
      { type: 'tool_use', toolUseId: 'toolu_fake_001', name: 'mcp__flota__delegate', input: { role: 'metrics-scan', charter: 'scan the repo', task: 'find dead code' } },
      { type: 'tool_result', toolUseId: 'toolu_fake_001', text: 'spawned crew-1 (task t2)', isError: undefined },
    ]);
    expect(driver.toolEvents).toEqual(events);

    // (c) final text returned.
    expect(out.text).toBe('Delegated: spawned crew-1 (task t2)');
    expect(out.responseMessages).toEqual([]);
    expect(out.billing).toBe('subscription');

    // (d) session_id + usage parsed off the result event.
    expect(out.usage).toEqual({ inputTokens: 42, outputTokens: 7 });

    // First-turn argv: --mcp-config carrying a FILE PATH (not inline JSON —
    // token-out-of-argv fix), --strict-mcp-config, --allowedTools scoped to
    // mcp__flota__*, --append-system-prompt carrying MCP_TOOL_GUIDANCE, no
    // --resume.
    const [args] = readLog(logFile);
    const mcpConfigIdx = args.indexOf('--mcp-config');
    expect(mcpConfigIdx).toBeGreaterThanOrEqual(0);
    const mcpConfigPath = args[mcpConfigIdx + 1];
    // The value at --mcp-config is a filesystem path, not inline JSON — the
    // bearer token must never appear in argv itself.
    expect(mcpConfigPath).not.toContain(token);
    expect(() => JSON.parse(mcpConfigPath)).toThrow(); // not itself parseable JSON
    // The file at that path holds the real config, mode 0600 (owner-only).
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf8'))).toEqual({
      mcpServers: { flota: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
    });
    expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o600);

    expect(args).toEqual([
      '-p', '[TASK from operator · task t1] scan the repo',
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__flota__*',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', `You are captain.\n\n${MCP_TOOL_GUIDANCE}`,
    ]);
    expect(args).not.toContain('--resume');
    driver.cleanup();
  });

  it('second turn: --resume replaces --append-system-prompt, --mcp-config and --allowedTools still re-passed', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const driver = new McpClaudeDriver({ workspaceDir, mcpUrl: url, token, bin: FIXTURE });

    await driver.turn(turnInput('turn one'));
    const out2 = await driver.turn(turnInput('turn two'));

    expect(out2.text).toBe('Delegated: spawned crew-1 (task t2)');
    // delegate fired twice — once per turn, each a real round trip.
    expect(api.delegate).toHaveBeenCalledTimes(2);

    const [args1, args2] = readLog(logFile);
    // WHY reuse the FIRST turn's --mcp-config path, not re-derive one: the
    // driver writes the config file once in the constructor — the same path
    // must be re-passed on resume (same file, still on disk).
    const mcpConfigPath = args1[args1.indexOf('--mcp-config') + 1];
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf8'))).toEqual({
      mcpServers: { flota: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
    });
    expect(args2).toEqual([
      '-p', 'turn two',
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__flota__*',
      '--output-format', 'stream-json',
      '--verbose',
      '--resume', 'sess-mcp-1',
    ]);
    expect(args2).not.toContain('--append-system-prompt');
    driver.cleanup();
  });

  it('crew token: report tool round-trips too (not just delegate)', async () => {
    // Swap the fixture's expectations by pointing a crew driver at a token
    // whose role gates delegate off — the stub always calls "delegate" by
    // name, so this asserts the server's own role gate (not the driver) is
    // what's exercised: the call still round-trips, but returns the
    // role-error text instead of firing KernelApi.delegate.
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'crew-1', role: 'crew', api, taskId: 't2' };
    const token = server.registerNode(ctx);

    const driver = new McpClaudeDriver({ workspaceDir, mcpUrl: url, token, bin: FIXTURE });
    const out = await driver.turn(turnInput('scan'));

    expect(api.delegate).not.toHaveBeenCalled();
    expect(out.text).toBe('Delegated: error: delegate is not available to this role');
  });

  it('unparseable stdout throws (retry-then-fail is the node layer\'s job)', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    // A CLI stand-in that never round-trips through MCP at all — asserts the
    // parser's own contract (throw, not a silently-empty turn) independent of
    // the real-round-trip stub.
    const garbageBin = join(workspaceDir, 'garbage-claude.sh');
    writeFileSync(garbageBin, '#!/usr/bin/env bash\necho "not json"\n', { mode: 0o755 });
    const badDriver = new McpClaudeDriver({ workspaceDir, mcpUrl: url, token, bin: garbageBin });

    await expect(badDriver.turn(turnInput('scan'))).rejects.toThrow(
      'claude (mcp mode) produced no result event and no assistant text',
    );
    expect(badDriver.toolEvents).toEqual([]);
    expect(api.delegate).not.toHaveBeenCalled();
  });

  it('a throwing onToolEvent does NOT reject the turn (protects against double-fired side effects on retry)', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    const driver = new McpClaudeDriver({
      workspaceDir,
      mcpUrl: url,
      token,
      bin: FIXTURE,
      onToolEvent: () => { throw new Error('logging hook blew up'); },
    });

    // The turn completes normally despite the throwing consumer — no re-run.
    const out = await driver.turn(turnInput('scan'));
    expect(out.text).toBe('Delegated: spawned crew-1 (task t2)');
    expect(api.delegate).toHaveBeenCalledTimes(1); // fired once, not twice

    // The snapshot is still complete — push happens outside the guarded call.
    expect(driver.toolEvents).toEqual([
      { type: 'tool_use', toolUseId: 'toolu_fake_001', name: 'mcp__flota__delegate', input: { role: 'metrics-scan', charter: 'scan the repo', task: 'find dead code' } },
      { type: 'tool_result', toolUseId: 'toolu_fake_001', text: 'spawned crew-1 (task t2)', isError: undefined },
    ]);
  });

  it('a failed execFile does NOT leak the bearer token in the thrown error', async () => {
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);

    // A stub that exits non-zero: execFile rejects with Error.message/.cmd
    // carrying the full argv. Post token-out-of-argv fix, argv only ever
    // holds the mcp-config FILE PATH, not the token — so this is really a
    // regression guard (the token must never reappear in argv) rather than
    // a redaction-in-action test; see the next test for that.
    const failBin = join(workspaceDir, 'failing-claude.sh');
    writeFileSync(failBin, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const driver = new McpClaudeDriver({ workspaceDir, mcpUrl: url, token, bin: failBin });

    let caught: unknown;
    try {
      await driver.turn(turnInput('scan'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { cmd?: string };
    // The token must appear nowhere in the surfaced error (node.ts does
    // onModelFailure(id, String(err)) straight into the event log).
    expect(token.length).toBeGreaterThan(0);
    expect(e.message).not.toContain(token);
    expect(e.cmd ?? '').not.toContain(token);
    expect(e.stack ?? '').not.toContain(token);
    driver.cleanup();
  });

  it('redacts the token from err.stack, not just err.message/err.cmd (defense-in-depth)', () => {
    // WHY synthesize the error rather than drive a real failing execFile: with
    // the token out of argv (Fix 1), a real execFile rejection no longer puts
    // the token in message/cmd/stack at all, so there's nothing there to prove
    // redaction ACTUALLY scrubs stack (as opposed to stack simply never having
    // had the token). This pins redactToken's own contract directly: given an
    // Error whose .stack was baked (by Node, at construction time) from a
    // message that contained the token — the realistic shape of the bug this
    // fix closes — scrub() must strip the token from .stack too.
    const api = fakeApi();
    const ctx: McpNodeContext = { nodeId: 'captain', role: 'captain', api, taskId: 't1' };
    const token = server.registerNode(ctx);
    const driver = new McpClaudeDriver({ workspaceDir, mcpUrl: url, token, bin: FIXTURE });

    const err = new Error(`Command failed: claude --mcp-config /tmp/x --header "Bearer ${token}"`);
    // Node bakes .message into .stack at construction — reproduce that here
    // rather than relying on the engine to do it, since we're not actually
    // throwing this Error through V8's real construction path.
    err.stack = `Error: Command failed: claude --mcp-config /tmp/x --header "Bearer ${token}"\n    at fake.js:1:1`;

    const redacted = (driver as unknown as { redactToken: (e: unknown) => Error }).redactToken(err);

    expect(redacted.message).not.toContain(token);
    expect(redacted.stack).not.toContain(token);
    expect(redacted.stack).toContain('<redacted>');
    driver.cleanup();
  });

  it('parser: a tool_result with is_error:true yields isError:true', () => {
    // The round-trip stub never exercises a failed tool_result — pin the parse
    // path directly without a real CLI.
    const stdout = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__flota__deliver', input: { text: 'x' } }] }, session_id: 's1' }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'tu1', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

    const parsed = parseMcpClaudeStdout(stdout);
    const toolResult = parsed.events.find(e => e.type === 'tool_result');
    expect(toolResult).toEqual({ type: 'tool_result', toolUseId: 'tu1', text: 'boom', isError: true });
  });
});
