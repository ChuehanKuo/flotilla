import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';
import { formatTurnPrompt, parseCommands, executeCommands, PROTOCOL_INSTRUCTIONS } from '../protocol.js';
import type { CliDriverSpec } from './specs.js';

const execFile = promisify(execFileCb);

export interface CliDriverOptions {
  workspaceDir: string;
  bin?: string;
  timeoutMs?: number;
}

// WHY one shared turn loop, spec-parameterized: claude-code and codex ran
// near-identical turn() bodies differing only in argv construction and stdout
// parsing. CliDriver owns the loop; a CliDriverSpec supplies those two axes, so
// a user can bring their own agent CLI by writing a spec — no new driver class.
//
// WHY per-instance session/queue state: one CliDriver is constructed per node
// and lives across that node's whole mission — resume needs the CLI's own
// session id from a prior reply, and command results from turn N must reach
// turn N+1's prompt without the kernel/node layer knowing about either.
export class CliDriver implements TurnDriver {
  private sessionId: string | undefined;
  private pendingCommandResults: string[] = [];

  constructor(
    private readonly spec: CliDriverSpec,
    private readonly opts: CliDriverOptions,
  ) {}

  async turn(input: TurnInput): Promise<TurnOutput> {
    // WHY captured up front: it selects firstArgs vs resumeArgs AND tells the
    // spec's parse whether this is the session-establishing turn — context that
    // lives here, in whether this.sessionId was already set walking in.
    const isFirstTurn = this.sessionId === undefined;

    // WHY promptText never begins with '-': node.ts formats every incoming batch
    // as `[KIND from …]` lines (and pending results add a `[command results]`
    // header), so a leading token can't be parsed as a flag by the CLI. If that
    // upstream invariant ever changes, revisit this call site.
    const promptText = formatTurnPrompt(input.newText, this.pendingCommandResults);
    const ctx = {
      prompt: promptText,
      system: input.system,
      workspaceDir: this.opts.workspaceDir,
      protocol: PROTOCOL_INSTRUCTIONS,
      sessionId: this.sessionId,
    };
    const args = isFirstTurn ? this.spec.firstArgs(ctx) : this.spec.resumeArgs(ctx);

    // WHY no `env` override: execFile inherits process.env by default, which is
    // exactly what both sides need — tests rely on it to pass FAKE_CLI_LOG/
    // FAKE_CLI_REPLY to the stub, and production relies on it to pass the
    // user's normal CLI auth/session env through untouched. WHY execFile (no
    // shell): args are passed as an array, never interpolated into a command
    // line — no shell injection surface.
    const { stdout } = await execFile(this.opts.bin ?? this.spec.command, args, {
      cwd: this.opts.workspaceDir,
      signal: input.abortSignal,
      timeout: this.opts.timeoutMs ?? this.spec.timeoutMs ?? 600_000,
      maxBuffer: 10 * 2 ** 20,
    });

    // WHY no try/catch here: an unparseable/empty stream, an empty final text,
    // or a missing session id must throw so the node's retry-then-escalate
    // machinery handles it — never swallow it into a silently-empty or
    // silently-amnesiac turn. spec.parse itself throws for these cases.
    const result = this.spec.parse(stdout, { isFirstTurn });

    // The turn succeeded — only now drain the queue. A thrown execFile/parse
    // above leaves it intact, so the node's retry of the same newText rebuilds
    // the prompt with the same [command results] block instead of losing it.
    this.pendingCommandResults = [];

    if (result.sessionId) this.sessionId = result.sessionId;

    // WHY commands come from transcript but display text from displayText: a CLI
    // may run its own internal multi-turn loop and emit its flotilla block in an
    // intermediate turn, then narrate in its final (display) turn without
    // repeating the block — scanning the whole transcript catches the block
    // wherever it appeared (parseCommands keeps only the LAST block found).
    // Display text stays the clean final-turn summary. A spec that has no
    // separate display text (displayText undefined) shows the transcript's own
    // clean text.
    const { commands } = parseCommands(result.transcript);
    this.pendingCommandResults = await executeCommands(commands, input.tools);
    const text =
      result.displayText !== undefined
        ? parseCommands(result.displayText).cleanText
        : parseCommands(result.transcript).cleanText;

    return {
      text,
      responseMessages: [],
      usage: result.usage,
      billing: 'subscription',
    };
  }
}
