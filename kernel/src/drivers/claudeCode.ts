import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';
import { formatTurnPrompt, parseCommands, executeCommands, PROTOCOL_INSTRUCTIONS } from '../protocol.js';

const execFile = promisify(execFileCb);

export interface ClaudeCodeDriverOptions {
  workspaceDir: string;
  bin?: string;
  timeoutMs?: number;
}

// WHY only `type`/`message.content[].type|text`/`session_id`/`result`/`usage`
// fields: `claude -p --output-format stream-json --verbose` emits one JSON
// object per line — shape verified against the installed CLI (2.1.207) via a
// non-mutating probe (`-p "..." --output-format stream-json --verbose
// --allowedTools ''`). Real streams also carry `system` (init/hook) and
// `rate_limit_event` lines and `thinking`/`tool_use` content blocks — all
// silently ignored by the narrow shape below rather than enumerated.
interface StreamEvent {
  type?: unknown;
  message?: { content?: unknown };
  session_id?: unknown;
  result?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

// WHY per-instance session/queue state: one ClaudeCodeDriver is constructed per
// node and lives across that node's whole mission — `--resume` needs the CLI's
// own session_id from the prior reply, and command results from turn N must
// reach turn N+1's prompt without the kernel/node layer knowing about either.
export class ClaudeCodeDriver implements TurnDriver {
  private sessionId: string | undefined;
  private pendingCommandResults: string[] = [];

  constructor(private readonly opts: ClaudeCodeDriverOptions) {}

  async turn(input: TurnInput): Promise<TurnOutput> {
    // WHY promptText never begins with '-': node.ts formats every incoming batch
    // as `[KIND from …]` lines (and pending results add a `[command results]`
    // header), so `-p <text>` can't parse a leading token as a flag. If that
    // upstream invariant ever changes, revisit this call site.
    const promptText = formatTurnPrompt(input.newText, this.pendingCommandResults);
    const args = this.buildArgs(promptText, input.system);

    // WHY no `env` override: execFile inherits process.env by default, which is
    // exactly what both sides need — tests rely on it to pass FAKE_CLI_LOG/
    // FAKE_CLI_REPLY to the stub, and production relies on it to pass the
    // subscription's normal `claude` auth/session env through untouched.
    const { stdout } = await execFile(this.opts.bin ?? 'claude', args, {
      cwd: this.opts.workspaceDir,
      signal: input.abortSignal,
      timeout: this.opts.timeoutMs ?? 600_000,
      maxBuffer: 10 * 2 ** 20,
    });

    // WHY no try/catch here: an unparseable stream, or one with no result event
    // and no assistant text at all, must throw so the node's retry-then-
    // escalate machinery handles it — never swallow it into a silently-empty
    // turn. parseStdout itself throws for both cases.
    const { fullTranscript, resultText, sessionId, usage } = this.parseStdout(stdout);

    // The turn succeeded — only now drain the queue. A thrown execFile/parseStdout
    // above leaves it intact, so the node's retry of the same newText rebuilds
    // the prompt with the same [command results] block instead of losing it.
    this.pendingCommandResults = [];

    if (sessionId) this.sessionId = sessionId;
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

    // WHY commands come from fullTranscript but display text from resultText:
    // headless Claude runs its own internal multi-turn loop and can emit its
    // flotilla block in an intermediate turn, then narrate in its final turn
    // (the `result` event's text) without repeating the block — scanning only
    // `result` misses the block (the P7 bug). Scanning the whole transcript
    // catches it wherever it appeared (parseCommands keeps only the LAST
    // block found). Display text stays the clean final-turn summary, not the
    // full multi-turn reasoning dump.
    const { commands } = parseCommands(fullTranscript);
    this.pendingCommandResults = await executeCommands(commands, input.tools);
    const text = resultText !== undefined ? parseCommands(resultText).cleanText : parseCommands(fullTranscript).cleanText;

    return {
      text,
      responseMessages: [],
      usage: { inputTokens, outputTokens },
      billing: 'subscription',
    };
  }

  // WHY line-by-line with per-line try/catch: stream-json prints NDJSON, one
  // event object per line — a single JSON.parse(stdout) would fail on the
  // very first reply. Unparseable individual lines are skipped rather than
  // failing the whole turn (log noise, partial writes) — mirrors CodexDriver's
  // parseStdout (kernel/src/drivers/codex.ts).
  private parseStdout(stdout: string): {
    fullTranscript: string;
    resultText: string | undefined;
    sessionId: string | undefined;
    usage: { input_tokens?: unknown; output_tokens?: unknown };
  } {
    const turnTexts: string[] = [];
    let resultEvent: StreamEvent | undefined;
    let lastAssistantSessionId: string | undefined;

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip unparseable lines
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const event = parsed as StreamEvent;

      if (event.type === 'assistant') {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
              const blockText = (block as { text?: unknown }).text;
              if (typeof blockText === 'string') parts.push(blockText);
            }
          }
          if (parts.length > 0) turnTexts.push(parts.join(''));
        }
        if (typeof event.session_id === 'string') lastAssistantSessionId = event.session_id;
      } else if (event.type === 'result') {
        resultEvent = event;
      }
    }

    // WHY join with '\n': FENCE_RE (protocol.ts) requires a flotilla block's
    // opening fence to start at a line boundary. Assistant turn texts aren't
    // guaranteed to end with a trailing newline, so concatenating turns with
    // '' could glue one turn's tail directly onto the next turn's leading
    // ```flotilla and hide a genuine block from the regex.
    const fullTranscript = turnTexts.join('\n');
    const resultText = resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result : undefined;

    // Zero parseable lines from non-empty garbage stdout, or valid NDJSON that
    // never carried a result event or any assistant text (e.g. only system/
    // rate_limit_event lines) — both leave nothing for the node to act on.
    if (fullTranscript === '' && resultText === undefined) {
      throw new Error('claude produced no result event and no assistant text');
    }

    const sessionId =
      (resultEvent && typeof resultEvent.session_id === 'string' ? resultEvent.session_id : undefined) ??
      lastAssistantSessionId;
    const usage = resultEvent?.usage ?? {};

    return { fullTranscript, resultText, sessionId, usage };
  }

  private buildArgs(promptText: string, system: string): string[] {
    const auth = this.sessionId
      ? ['--resume', this.sessionId]
      : ['--append-system-prompt', `${system}\n\n${PROTOCOL_INSTRUCTIONS}`];
    // WHY Tool(**) not bare Tool names: unscoped Read/Write/Edit let the CLI
    // touch any path reachable from its own permission model, not just this
    // node's mission workspace. Permission rules take a `Tool(specifier)`
    // glob scoped to cwd (verified via `claude --help`'s own allowedTools
    // example and the CLI's rule-format validation message, which both cite
    // gitignore-style relative globs, e.g. "Edit(docs/**)"); since cwd is
    // already workspaceDir (see execFile's `cwd` below), `**` scopes every
    // Read/Write/Edit to inside it. Glob/Grep stay unscoped (read-only search).
    return [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--verbose',
      ...auth,
      '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
    ];
  }
}
