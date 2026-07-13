import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';
import { parseCommands, executeCommands, PROTOCOL_INSTRUCTIONS } from '../protocol.js';

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
    const promptText = this.buildPromptText(input.newText);
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

    if (typeof reply.session_id === 'string') this.sessionId = reply.session_id;
    const resultText = typeof reply.result === 'string' ? reply.result : '';
    const usage = reply.usage ?? {};
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

    const { commands, cleanText } = parseCommands(resultText);
    this.pendingCommandResults = await executeCommands(commands, input.tools);

    return {
      text: cleanText,
      responseMessages: [],
      usage: { inputTokens, outputTokens },
      billing: 'subscription',
    };
  }

  private buildPromptText(newText: string): string {
    // WHY neutralize here: a crew's delivered text can contain a raw line-start
    // ``` fence (e.g. quoting code); if the captain's CLI echoes that text back
    // verbatim, parseCommands must not mistake it for a real flotilla block on
    // a later turn. Indenting by one space is cheap and reversible-by-eye.
    const neutralized = newText.replace(/^```/gm, ' ```');
    if (this.pendingCommandResults.length === 0) return neutralized;
    const header = `[command results]\n${this.pendingCommandResults.join('\n')}`;
    this.pendingCommandResults = [];
    return `${header}\n\n${neutralized}`;
  }

  private buildArgs(promptText: string, system: string): string[] {
    const auth = this.sessionId
      ? ['--resume', this.sessionId]
      : ['--append-system-prompt', `${system}\n\n${PROTOCOL_INSTRUCTIONS}`];
    return ['-p', promptText, '--output-format', 'json', ...auth, '--allowedTools', 'Read,Write,Edit,Glob,Grep'];
  }
}
