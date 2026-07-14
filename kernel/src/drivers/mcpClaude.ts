import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { TurnDriver, TurnInput, TurnOutput } from '../driver.js';

const execFile = promisify(execFileCb);

// WHY this replaces PROTOCOL_INSTRUCTIONS in MCP mode: the fenced-JSON protocol
// existed only because CLI-driver agents had no real tools to call. Here they
// do (mcp__flota__*, wired via --mcp-config below) — the only failure mode
// left is the model narrating an action instead of invoking the tool, which is
// what this text guards against. Much shorter than PROTOCOL_INSTRUCTIONS
// because there's no JSON shape to teach, no fence syntax to enforce.
export const MCP_TOOL_GUIDANCE =
  'You have real tools: mcp__flota__delegate, __report, __deliver, __escalate, __answer. ' +
  'To act, CALL the tool. Do not describe or narrate an action — calling the tool is the ' +
  'only thing that does anything. When your task is complete, call deliver.';

export interface McpClaudeDriverOptions {
  workspaceDir: string;
  mcpUrl: string;
  token: string;
  bin?: string;
  timeoutMs?: number;
  // WHY a callback, not just the toolEvents getter below: M4's logging wants
  // events as they're discovered mid-parse (to append to the mission's
  // EventLog in order), not just a post-turn snapshot. The getter still
  // exists for tests/inspection that don't need streaming.
  onToolEvent?: (event: McpToolEvent) => void;
}

// A tool_use/tool_result pair observed on the stream-json wire (§3 of the
// spike findings). Not a TurnOutput field (TurnOutput has no event channel) —
// see McpClaudeDriverOptions.onToolEvent / McpClaudeDriver.toolEvents for the
// two ways a caller can get at these; this is the integration point M4 wires
// into mission logging.
export interface McpToolEvent {
  type: 'tool_use' | 'tool_result';
  toolUseId: string;
  name?: string;   // tool_use only, e.g. 'mcp__flota__delegate'
  input?: unknown; // tool_use only
  text?: string;   // tool_result only, the returned content's text
  isError?: boolean; // tool_result only, when the CLI reports one
}

interface ParsedMcpTurn {
  displayText: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
  events: McpToolEvent[];
}

// WHY narrow unknown-typed fields, not a full stream-json interface: mirrors
// specs.ts's StreamEvent — only the fields this parser reads are typed: the
// rest of the real stream (system/init lines, thinking blocks, rate_limit
// events) is silently ignored rather than enumerated.
interface StreamContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface StreamEvent {
  type?: unknown;
  message?: { content?: unknown };
  session_id?: unknown;
  result?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  tool_use_result?: unknown;
}

function textOfBlock(block: StreamContentBlock, event: StreamEvent): string | undefined {
  // WHY two extraction paths: the spike confirmed tool_result events carry the
  // SAME text redundantly in both message.content[].tool_result.content[] and
  // the top-level tool_use_result[] — either is usable; content[] is tried
  // first since it's scoped to the specific block, tool_use_result as fallback
  // for a shape where only the top-level array is populated.
  const inline = block.content;
  if (Array.isArray(inline)) {
    const first = inline[0];
    if (first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      return (first as { text: string }).text;
    }
  }
  const topLevel = event.tool_use_result;
  if (Array.isArray(topLevel)) {
    const first = topLevel[0];
    if (first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      return (first as { text: string }).text;
    }
  }
  return undefined;
}

// WHY line-by-line with per-line try/catch: stream-json is NDJSON, one event
// per line — mirrors parseClaudeStdout (specs.ts). Extracts tool_use/
// tool_result events (new — the MCP-mode observability this driver adds) plus
// the same session_id/usage/final-text fields the fenced-JSON claude spec
// pulls, but never scans for a ```flota block: there is none to find.
function parseMcpClaudeStdout(stdout: string): ParsedMcpTurn {
  const events: McpToolEvent[] = [];
  let lastAssistantText: string | undefined;
  let lastAssistantSessionId: string | undefined;
  let resultEvent: StreamEvent | undefined;

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
        const textParts: string[] = [];
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as StreamContentBlock;
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            events.push({
              type: 'tool_use',
              toolUseId: block.id,
              name: typeof block.name === 'string' ? block.name : undefined,
              input: block.input,
            });
          }
        }
        // WHY overwrite, not accumulate: unlike parseClaudeStdout's fenced-JSON
        // transcript (which must scan every turn for a block that could appear
        // anywhere), MCP mode only needs the LAST assistant text as the
        // deliverable fallback — intermediate narration between tool calls
        // isn't the thing a caller wants back.
        if (textParts.length > 0) lastAssistantText = textParts.join('');
      }
      if (typeof event.session_id === 'string') lastAssistantSessionId = event.session_id;
    } else if (event.type === 'user') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as StreamContentBlock;
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            events.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              text: textOfBlock(block, event),
              isError: typeof block.is_error === 'boolean' ? block.is_error : undefined,
            });
          }
        }
      }
    } else if (event.type === 'result') {
      resultEvent = event;
    }
  }

  const resultText = resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result : undefined;
  const displayText = resultText !== undefined ? resultText : lastAssistantText;

  // WHY throw rather than return '': an empty "success" would silently drain
  // downstream state and complete a node turn with nothing to show — fail
  // loudly so the node's retry-then-escalate machinery (node.ts
  // callDriverWithRetry) reacts instead of a silently-empty turn.
  if (displayText === undefined || displayText === '') {
    throw new Error('claude (mcp mode) produced no result event and no assistant text');
  }

  const sessionId =
    (resultEvent && typeof resultEvent.session_id === 'string' ? resultEvent.session_id : undefined) ??
    lastAssistantSessionId;
  const usage = resultEvent?.usage ?? {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  return { displayText, sessionId, usage: { inputTokens, outputTokens }, events };
}

// WHY a standalone TurnDriver, not a CliDriverSpec plugged into CliDriver:
// CliDriver's shared turn loop always calls parseCommands/executeCommands on
// the transcript (the fenced-JSON path) and threads a pendingCommandResults
// queue turn-to-turn — both are dead weight in MCP mode, where tool calls
// already executed via HTTP during the run and there is no [command results]
// queue to carry (see the brief). Duplicating the ~15-line execFile/session
// skeleton here is cheaper than bending CliDriver to skip steps it always does.
export class McpClaudeDriver implements TurnDriver {
  private sessionId: string | undefined;
  private events: McpToolEvent[] = [];

  constructor(private readonly opts: McpClaudeDriverOptions) {}

  // WHY exposed alongside onToolEvent: a caller that didn't pass onToolEvent
  // (e.g. a test) still needs a way to inspect what tool calls happened this
  // mission — this is the read-after-the-fact half of the M4 integration point.
  get toolEvents(): readonly McpToolEvent[] {
    return this.events;
  }

  async turn(input: TurnInput): Promise<TurnOutput> {
    const isFirstTurn = this.sessionId === undefined;

    const mcpConfig = JSON.stringify({
      mcpServers: {
        flota: {
          type: 'http',
          url: this.opts.mcpUrl,
          headers: { Authorization: `Bearer ${this.opts.token}` },
        },
      },
    });

    // WHY --mcp-config + --allowedTools repeated on resume: the spike found
    // neither is remembered across --resume — omitting them on turn 2+ would
    // silently strip the agent's only tools mid-mission.
    const authTail = isFirstTurn
      ? ['--append-system-prompt', `${input.system}\n\n${MCP_TOOL_GUIDANCE}`]
      : ['--resume', this.sessionId as string];

    const args = [
      '-p', input.newText,
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__flota__*',
      '--output-format', 'stream-json',
      '--verbose',
      ...authTail,
    ];

    // WHY no `env` override, no pendingCommandResults: mirrors CliDriver's
    // execFile call (inherits process.env for CLI auth/session) but drops the
    // fenced-JSON queue entirely — tool results already fed back into the
    // agent's own loop over HTTP during the run, nothing to re-inject next turn.
    const { stdout } = await execFile(this.opts.bin ?? 'claude', args, {
      cwd: this.opts.workspaceDir,
      signal: input.abortSignal,
      timeout: this.opts.timeoutMs ?? 600_000,
      maxBuffer: 10 * 2 ** 20,
    });

    // WHY no try/catch: an unparseable/empty stream throws inside parse — let
    // it propagate so the node's retry-then-escalate machinery handles it,
    // same contract as CliDriver.
    const result = parseMcpClaudeStdout(stdout);

    if (result.sessionId) this.sessionId = result.sessionId;
    for (const event of result.events) {
      this.events.push(event);
      this.opts.onToolEvent?.(event);
    }

    return {
      text: result.displayText,
      responseMessages: [],
      usage: result.usage,
      billing: 'subscription',
    };
  }
}
