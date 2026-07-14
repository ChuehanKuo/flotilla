import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';

const execFile = promisify(execFileCb);

// WHY this replaces PROTOCOL_INSTRUCTIONS entirely (not alongside it): MCP mode
// gives codex real callable tools (mcp__flota__*) wired to the in-process
// FlotaMcpServer — the fenced-```flota-block text protocol codex.ts/CliDriver
// use is irrelevant here and would just confuse the model with two competing
// instruction sets. Defined locally (not imported from a claude MCP driver
// file) per the brief: this task owns mcpCodex.ts only, and must not couple to
// whatever the parallel M3 task's mcpClaude.ts does with its own copy.
export const MCP_TOOL_GUIDANCE =
  'You have real tools mcp__flota__delegate/report/deliver/escalate/answer — CALL them to act; describing an action does nothing; call deliver when done.';

export interface McpCodexDriverOptions {
  workspaceDir: string;
  mcpUrl: string;
  token: string;
  bin?: string;
  timeoutMs?: number;
}

// -c overrides applied to both the first turn and every resumed turn. WHY
// default_tools_approval_mode="approve" specifically (not "auto"/"never"):
// spike findings §4 — approval_policy governs shell/exec only, and of the four
// legal values for this key ("auto"|"prompt"|"writes"|"approve"), only
// "approve" fires the MCP tool call non-interactively; "auto" still requires
// an interactive approval and hangs/cancels headlessly. WHY bearer via
// bearer_token_env_var + a real env var (not embedding the raw token in the
// -c value): keeps the per-node secret out of argv/process listings.
function mcpConfigFlags(mcpUrl: string): string[] {
  return [
    '-c', `mcp_servers.flota.url="${mcpUrl}"`,
    '-c', `mcp_servers.flota.default_tools_approval_mode="approve"`,
    '-c', `mcp_servers.flota.bearer_token_env_var="FLOTA_MCP_TOKEN"`,
  ];
}

function firstArgs(promptText: string, workspaceDir: string, mcpUrl: string): string[] {
  return ['exec', promptText, ...mcpConfigFlags(mcpUrl), '--json', '--sandbox', 'workspace-write', '--cd', workspaceDir];
}

// WHY no --cd/--sandbox here: verified against the installed CLI (mirrors
// CODEX_SPEC.resumeArgs in specs.ts) — `codex exec resume` rejects both flags
// ("unexpected argument '--cd' found"); the resumed session already carries
// the cwd/sandbox policy set on the first turn. The -c mcp overrides DO still
// need to be resent — nothing here suggests config from turn one persists
// into a resumed session's tool wiring, and the risk of a resumed turn losing
// MCP access silently is worse than sending three redundant flags.
function resumeArgs(promptText: string, sessionId: string, mcpUrl: string): string[] {
  return ['exec', 'resume', sessionId, promptText, ...mcpConfigFlags(mcpUrl), '--json'];
}

// WHY a per-instance temp CODEX_HOME rather than the user's ~/.codex: trust is
// directory-scoped ([projects."<path>"] trust_level="trusted" in
// $CODEX_HOME/config.toml) — writing into the user's real config would either
// require touching their file (never, without consent) or fail to grant trust
// at all. A fresh CODEX_HOME per driver instance is disposable and isolates
// one node's trust grant from every other node/mission.
function buildConfigToml(workspaceDir: string): string {
  const escaped = workspaceDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[projects."${escaped}"]\ntrust_level = "trusted"\n`;
}

interface CodexMcpEvent {
  type?: unknown;
  text?: unknown;
  session_id?: unknown;
  thread_id?: unknown;
  item?: {
    server?: unknown;
    tool?: unknown;
    arguments?: unknown;
    result?: unknown;
    error?: { message?: unknown };
  };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

interface McpCodexParseResult {
  text: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
}

// WHY console.error, not accumulated on TurnOutput: TurnOutput's shape is
// owned by driver.ts (out of scope for this task) and has no slot for
// per-turn tool-call events. Logging each mcp_tool_call lifecycle event is
// the observability point the brief asks for — a human/log-scraper watching
// the mission sees exactly which flota tools codex actually invoked (and any
// rejection, e.g. an approval regression) without threading a new return field
// through code this task must not touch.
function logMcpToolEvent(type: unknown, item: NonNullable<CodexMcpEvent['item']>): void {
  if (type === 'item.started') {
    console.error(`[mcpCodex] tool_call started: ${item.server}.${item.tool} args=${JSON.stringify(item.arguments)}`);
  } else if (type === 'item.completed') {
    if (item.error && typeof item.error === 'object' && item.error.message) {
      console.error(`[mcpCodex] tool_call failed: ${item.server}.${item.tool} error=${item.error.message}`);
    } else {
      console.error(`[mcpCodex] tool_call completed: ${item.server}.${item.tool} result=${JSON.stringify(item.result)}`);
    }
  }
}

// Mirrors CODEX_SPEC.parse (specs.ts) — line-delimited JSON, skip unparseable
// lines, extract session/thread id + concatenated agent_message text, throw on
// unusable output — but adds mcp_tool_call item.started/item.completed
// observability logging and drops all fenced-```flota parsing (there is no
// text protocol to scan for in MCP mode; tool calls happen over the real MCP
// wire, not as text codex echoes back).
function parseCodexMcpStdout(stdout: string, ctx: { isFirstTurn: boolean }): McpCodexParseResult {
  const events: CodexMcpEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') events.push(parsed as CodexMcpEvent);
    } catch {
      // skip unparseable lines (log noise, partial writes)
    }
  }

  if (events.length === 0 && stdout.trim() === '') {
    throw new Error('codex exec produced no parseable output');
  }

  for (const e of events) {
    if (e.item && typeof e.type === 'string' && (e.type === 'item.started' || e.type === 'item.completed')) {
      logMcpToolEvent(e.type, e.item);
    }
  }

  let sessionId: string | undefined;
  for (const e of events) {
    const id = typeof e.session_id === 'string' ? e.session_id : typeof e.thread_id === 'string' ? e.thread_id : undefined;
    if (id) { sessionId = id; break; }
  }

  // See CODEX_SPEC.parse for the identical rationale: a clean, parseable
  // JSONL stream that never carried a session/thread id on the
  // session-establishing turn is a loud failure (retry-then-escalate), not a
  // silent fresh-session-per-turn amnesia.
  if (events.length > 0 && ctx.isFirstTurn && !sessionId) {
    throw new Error('codex output carried no session/thread id');
  }

  const agentMessageParts = events
    .filter(e => typeof e.type === 'string' && e.type.includes('agent_message') && typeof e.text === 'string')
    .map(e => e.text as string);

  let text: string;
  if (agentMessageParts.length > 0) {
    text = agentMessageParts.join('');
  } else {
    const last = events[events.length - 1];
    text = last && typeof last.text === 'string' ? last.text : stdout.trim();
  }

  if (text.trim() === '') throw new Error('empty turn text from codex output');

  // WHY zero unless an event explicitly carries numeric usage: codex exec
  // --json's event stream carries no documented token-usage event (per
  // CODEX_SPEC.parse's identical note) — this stays ready to pick one up if a
  // future codex version adds it, without inventing an event shape now.
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events) {
    if (e.usage && typeof e.usage.input_tokens === 'number' && typeof e.usage.output_tokens === 'number') {
      inputTokens = e.usage.input_tokens;
      outputTokens = e.usage.output_tokens;
    }
  }

  return { text, sessionId, usage: { inputTokens, outputTokens } };
}

// WHY implements TurnDriver directly, not CliDriver+CliDriverSpec: CliDriver's
// shared turn loop exists to run parseCommands/executeCommands over a fenced
// ```flota text block and thread pendingCommandResults into the next prompt.
// MCP mode has neither — codex calls delegate/report/deliver/escalate/answer
// as real tools against FlotaMcpServer *during* the single `codex exec`
// subprocess call (its own internal tool-use loop resolves them before
// printing the final agent_message), so there is nothing for a
// parseCommands/executeCommands pass to find afterward. Reusing CliDriver
// here would mean threading a no-op spec around machinery this driver
// doesn't need.
export class McpCodexDriver implements TurnDriver {
  private sessionId: string | undefined;
  readonly codexHome: string;

  constructor(private readonly opts: McpCodexDriverOptions) {
    // Created eagerly (not lazily on first turn) so codexHome is available for
    // inspection/cleanup immediately after construction, and so a broken
    // filesystem (no /tmp, permissions) fails fast at driver construction
    // rather than silently on the first turn.
    this.codexHome = mkdtempSync(join(tmpdir(), 'flota-codex-home-'));
    writeFileSync(join(this.codexHome, 'config.toml'), buildConfigToml(this.opts.workspaceDir));
  }

  async turn(input: TurnInput): Promise<TurnOutput> {
    const isFirstTurn = this.sessionId === undefined;
    // WHY charter+guidance only on the first turn: codex exec has no
    // system-prompt flag, so both travel inside the prompt text itself (mirrors
    // CODEX_SPEC.firstArgs) — re-sending them on every resumed turn would waste
    // tokens and the resumed session already has them from turn one.
    const promptText = isFirstTurn
      ? `[role charter]\n${input.system}\n\n${MCP_TOOL_GUIDANCE}\n\n${input.newText}`
      : input.newText;
    const args = isFirstTurn
      ? firstArgs(promptText, this.opts.workspaceDir, this.opts.mcpUrl)
      : resumeArgs(promptText, this.sessionId as string, this.opts.mcpUrl);

    const env = { ...process.env, CODEX_HOME: this.codexHome, FLOTA_MCP_TOKEN: this.opts.token };

    const pending = execFile(this.opts.bin ?? 'codex', args, {
      cwd: this.opts.workspaceDir,
      env,
      signal: input.abortSignal,
      timeout: this.opts.timeoutMs ?? 600_000,
      maxBuffer: 10 * 2 ** 20,
    });
    // WHY close stdin immediately, not `stdio: ['ignore', ...]`: verified
    // empirically — execFile's `stdio` option does not stop Node from leaving
    // the child's stdin open as an unclosed pipe (a child reading from stdin
    // hangs regardless). The promisified execFile attaches the live
    // ChildProcess as `.child` on the returned promise (documented Node
    // behavior) before it settles, so closing stdin here — before awaiting —
    // reliably reproduces `< /dev/null` (spike findings §4: codex prints
    // "Reading additional input from stdin..." and blocks until stdin closes).
    pending.child?.stdin?.end();

    const { stdout } = await pending;
    const result = parseCodexMcpStdout(stdout, { isFirstTurn });
    if (result.sessionId) this.sessionId = result.sessionId;

    return {
      text: result.text,
      responseMessages: [],
      usage: result.usage,
      billing: 'subscription',
    };
  }

  // Not wired into any mission lifecycle by this task (kernel.ts is out of
  // scope) — exposed so a caller (or a test) can remove the per-instance
  // CODEX_HOME once the node's driver is no longer needed.
  cleanup(): void {
    rmSync(this.codexHome, { recursive: true, force: true });
  }
}
