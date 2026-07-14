import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';
import { formatTurnPrompt, runTurnProtocol, PROTOCOL_INSTRUCTIONS } from '../protocol.js';

const execFile = promisify(execFileCb);

export interface CodexDriverOptions {
  workspaceDir: string;
  bin?: string;
  timeoutMs?: number;
}

interface CodexEvent {
  type?: unknown;
  text?: unknown;
  session_id?: unknown;
  thread_id?: unknown;
}

// WHY per-instance session/queue state: one CodexDriver is constructed per node
// and lives across that node's whole mission — `exec resume` needs the CLI's own
// session id from a prior reply, and command results from turn N must reach
// turn N+1's prompt without the kernel/node layer knowing about either. Same
// shape as ClaudeCodeDriver — see kernel/src/drivers/claudeCode.ts.
export class CodexDriver implements TurnDriver {
  private sessionId: string | undefined;
  private pendingCommandResults: string[] = [];

  constructor(private readonly opts: CodexDriverOptions) {}

  async turn(input: TurnInput): Promise<TurnOutput> {
    // WHY promptText never begins with '-': node.ts formats every incoming batch
    // as `[KIND from …]` lines (and pending results add a `[command results]`
    // header), so a positional PROMPT arg can't be mistaken for a flag by clap.
    // If that upstream invariant ever changes, revisit this call site.
    const body = formatTurnPrompt(input.newText, this.pendingCommandResults);
    // WHY charter only on the first turn: codex exec has no system-prompt flag,
    // so system + PROTOCOL_INSTRUCTIONS travel inside the prompt itself under a
    // `[role charter]` header. Re-sending it on every resumed turn would waste
    // tokens and drift from ClaudeCodeDriver's "system only once" behavior —
    // the resumed session already has it from turn one.
    const promptText = this.sessionId ? body : `[role charter]\n${input.system}\n\n${PROTOCOL_INSTRUCTIONS}\n\n${body}`;
    const args = this.sessionId ? this.resumeArgs(this.sessionId, promptText) : this.firstArgs(promptText);

    // WHY no `env` override: execFile inherits process.env by default, which is
    // exactly what both sides need — tests rely on it to pass FAKE_CLI_LOG/
    // FAKE_CLI_REPLY to the stub, and production relies on it to pass the
    // subscription's normal `codex` auth/session env through untouched.
    const { stdout } = await execFile(this.opts.bin ?? 'codex', args, {
      cwd: this.opts.workspaceDir,
      signal: input.abortSignal,
      timeout: this.opts.timeoutMs ?? 600_000,
      maxBuffer: 10 * 2 ** 20,
    });

    // WHY captured before parseStdout: parseStdout doesn't know whether this is
    // the turn establishing a fresh session — that context lives here, in
    // whether this.sessionId was already set walking in.
    const isFirstTurn = this.sessionId === undefined;

    // WHY no try/catch here: an unparseable/empty stream, an empty final text,
    // or (on the first turn) a missing session id must all throw so the node's
    // retry-then-escalate machinery handles it — never swallow any of them into
    // a silently-empty or silently-amnesiac turn. parseStdout itself throws for
    // these cases.
    const { text: resultText, sessionId } = this.parseStdout(stdout, isFirstTurn);

    // The turn succeeded — only now drain the queue. A thrown execFile/parseStdout
    // above leaves it intact, so the node's retry of the same newText rebuilds
    // the prompt with the same [command results] block instead of losing it.
    this.pendingCommandResults = [];

    if (sessionId) this.sessionId = sessionId;

    const { text, pendingCommandResults } = await runTurnProtocol(resultText, input.tools);
    this.pendingCommandResults = pendingCommandResults;

    return {
      text,
      responseMessages: [],
      // WHY always zero: codex exec --json's event stream carries no
      // brief-specified token-usage event; unlike ClaudeCodeDriver's reply.usage,
      // there is nothing here to defensively default away from — no speculative
      // parsing of an unspecified event shape.
      usage: { inputTokens: 0, outputTokens: 0 },
      billing: 'subscription',
    };
  }

  private firstArgs(promptText: string): string[] {
    return ['exec', promptText, '--json', '--cd', this.opts.workspaceDir, '--sandbox', 'workspace-write'];
  }

  // WHY no --cd/--sandbox here: the brief's args assumed `exec resume` accepts the
  // same flags as `exec`. Verified against the installed CLI (codex-cli 0.144.3)
  // via `codex exec resume --cd /tmp --sandbox workspace-write --help`, which
  // errors "unexpected argument '--cd' found" (and likewise for --sandbox alone) —
  // the resume subcommand only takes [SESSION_ID] [PROMPT] plus its own flag set
  // (--json among them). The resumed session already carries the cwd/sandbox
  // policy set on the first turn.
  private resumeArgs(sessionId: string, promptText: string): string[] {
    return ['exec', 'resume', sessionId, promptText, '--json'];
  }

  // WHY line-by-line with per-line try/catch: codex exec --json prints JSONL, one
  // event object per line — a single JSON.parse(stdout) (the ClaudeCodeDriver
  // approach) would fail on the very first reply. Unparseable individual lines
  // are skipped rather than failing the whole turn (log noise, partial writes).
  private parseStdout(stdout: string, isFirstTurn: boolean): { text: string; sessionId?: string } {
    const events: CodexEvent[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') events.push(parsed as CodexEvent);
      } catch {
        // skip unparseable lines
      }
    }

    if (events.length === 0 && stdout.trim() === '') {
      throw new Error('codex exec produced no parseable output');
    }

    let sessionId: string | undefined;
    for (const e of events) {
      const id = typeof e.session_id === 'string' ? e.session_id : typeof e.thread_id === 'string' ? e.thread_id : undefined;
      if (id) { sessionId = id; break; }
    }

    // WHY events.length > 0 gates this: zero parseable events falls straight to
    // the raw-stdout fallback below (a distinct, pre-existing degenerate case —
    // e.g. a CLI printing plain text, not JSONL at all). This guard targets a
    // stream that DID parse as valid JSONL but never carried a session/thread id
    // on the turn establishing a fresh session — the likeliest real-CLI
    // shape-mismatch symptom. Silent fresh-session-per-turn amnesia is worse
    // than a loud failure the retry-then-escalate machinery can react to.
    if (events.length > 0 && isFirstTurn && !sessionId) {
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

    // WHY throw instead of returning '' (and why trim(), not ===''): an empty
    // or whitespace-only "success" would silently drain the pending-command-
    // results queue and complete a node turn with nothing — fail loudly so
    // retry-then-escalate surfaces it instead.
    if (text.trim() === '') throw new Error('empty turn text from codex output');

    return { text, sessionId };
  }
}
