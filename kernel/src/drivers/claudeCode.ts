import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';
import { formatTurnPrompt, runTurnProtocol, PROTOCOL_INSTRUCTIONS } from '../protocol.js';

const execFile = promisify(execFileCb);

export interface ClaudeCodeDriverOptions {
  workspaceDir: string;
  bin?: string;
  timeoutMs?: number;
}

interface ClaudeCliReply {
  result?: unknown;
  session_id?: unknown;
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

    // WHY no try/catch here: unparseable stdout must throw so the node's
    // retry-then-escalate machinery handles it — never swallow it into a
    // silently-empty turn.
    const reply = JSON.parse(stdout) as ClaudeCliReply;

    // The turn succeeded — only now drain the queue. A thrown execFile/JSON.parse
    // above leaves it intact, so the node's retry of the same newText rebuilds
    // the prompt with the same [command results] block instead of losing it.
    this.pendingCommandResults = [];

    if (typeof reply.session_id === 'string') this.sessionId = reply.session_id;
    const resultText = typeof reply.result === 'string' ? reply.result : '';
    const usage = reply.usage ?? {};
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

    const { text, pendingCommandResults } = await runTurnProtocol(resultText, input.tools);
    this.pendingCommandResults = pendingCommandResults;

    return {
      text,
      responseMessages: [],
      usage: { inputTokens, outputTokens },
      billing: 'subscription',
    };
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
    return ['-p', promptText, '--output-format', 'json', ...auth, '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep'];
  }
}
