import { z } from 'zod';
import type { ToolSet } from 'ai';
import type { DriverKind } from './types.js';

export type Command =
  | { cmd: 'delegate'; role: string; charter: string; task: string; driver?: DriverKind }
  | { cmd: 'report'; text: string }
  | { cmd: 'deliver'; text: string }
  | { cmd: 'escalate'; question: string }
  | { cmd: 'answer'; taskId: string; text: string };

// WHY only the LAST fenced ```flotilla block: CLI-driver transcripts often show their
// reasoning inline before settling on a final action; treating every block as a command
// would double-execute draft attempts the model itself abandoned.
// WHY both the opening AND closing fence must begin a line ((?:^|\n)``` / \n```):
// inside valid JSON, newlines in string values are \n escapes, so a line-start ```
// can never occur within the payload — an embedded "``` code ```" in delivered text
// cannot truncate the block. Inline single-line blocks no longer match (acceptable:
// they fall through to no commands). Anchoring only the close (as before) left a gap:
// neutralizeFences prefixes echoed line-start ``` with a space, but an unanchored
// opening still matched that "```flotilla" wherever it fell in the string, letting a
// neutralized (attacker-echoed) block re-open as if genuine. No `m` flag is used —
// `(?:^|\n)` gets line-start semantics without it.
const FENCE_RE = /(?:^|\n)```flotilla\s*\n([\s\S]*?)\n```/g;

export function parseCommands(text: string): { commands: Command[]; cleanText: string } {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(FENCE_RE)) last = m;
  if (!last) return { commands: [], cleanText: text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1]);
  } catch {
    return { commands: [], cleanText: text };
  }
  const commands = (parsed as { commands?: unknown })?.commands;
  if (!Array.isArray(commands)) return { commands: [], cleanText: text };

  const cleanText = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  return { commands: commands as Command[], cleanText };
}

// WHY validate here: the ai package's tool() only enforces inputSchema inside the
// generateText pipeline — a direct .execute() call bypasses it entirely, so args
// arriving from an untrusted CLI transcript must be checked before they reach the
// kernel's coordination tools.
const COMMAND_SCHEMAS = {
  delegate: z.object({ role: z.string(), charter: z.string(), task: z.string(), driver: z.enum(['api', 'claude-code', 'codex']).optional() }),
  report: z.object({ text: z.string() }),
  deliver: z.object({ text: z.string() }),
  escalate: z.object({ question: z.string() }),
  answer: z.object({ taskId: z.string(), text: z.string() }),
} as const;

// WHY neutralize: text echoed into a CLI-driver prompt (a crew's delivered text, or
// an error branch's arbitrary err.message inside a command result) can contain a raw
// line-start ``` fence; if the CLI echoes it back verbatim, parseCommands must not
// mistake it for a real flotilla block on a later turn. Indenting by one space is
// cheap and reversible-by-eye.
function neutralizeFences(s: string): string {
  return s.replace(/^```/gm, ' ```');
}

// WHY shared here, not per-driver: prompt-shaping (fence neutralization + prefixing
// the queued command-result acks) is identical across every CLI driver — duplicating
// it risks one driver's copy drifting (e.g. forgetting to neutralize the joined
// queue, the Task P3 review's Minor 1). Pure: takes the queue by value, never
// mutates driver state — draining stays the caller's job, timed around the fallible
// subprocess call for retry coherence.
export function formatTurnPrompt(newText: string, pendingCommandResults: string[]): string {
  const neutralized = neutralizeFences(newText);
  if (pendingCommandResults.length === 0) return neutralized;
  const header = `[command results]\n${neutralizeFences(pendingCommandResults.join('\n'))}`;
  return `${header}\n\n${neutralized}`;
}

// WHY this is the shared tail of every driver's turn(): once a CLI reply has been
// reduced to its result text, parsing the flotilla block and executing any commands
// is identical regardless of which CLI produced that text.
export async function runTurnProtocol(
  resultText: string,
  tools: ToolSet,
): Promise<{ text: string; pendingCommandResults: string[] }> {
  const { commands, cleanText } = parseCommands(resultText);
  const pendingCommandResults = await executeCommands(commands, tools);
  return { text: cleanText, pendingCommandResults };
}

export async function executeCommands(commands: Command[], tools: ToolSet): Promise<string[]> {
  const results: string[] = [];
  for (const element of commands as unknown[]) {
    const cmd = typeof element === 'object' && element !== null ? (element as { cmd?: unknown }).cmd : undefined;
    // Object.hasOwn (not `in`/bracket lookup) so prototype-chain names like
    // "constructor" can never resolve to a schema or a tool.
    if (typeof cmd !== 'string' || !Object.hasOwn(COMMAND_SCHEMAS, cmd)) {
      results.push(`${String((element as { cmd?: unknown } | null)?.cmd ?? element)} → error: unknown command`);
      continue;
    }
    const { cmd: _, ...args } = element as Record<string, unknown>;
    const parsed = COMMAND_SCHEMAS[cmd as Command['cmd']].safeParse(args);
    if (!parsed.success) {
      results.push(`${cmd} → error: invalid arguments: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    const tool = Object.hasOwn(tools, cmd) ? tools[cmd] : undefined;
    if (!tool?.execute) {
      results.push(`${cmd} → error: unknown command`);
      continue;
    }
    try {
      const result = await tool.execute(parsed.data, { toolCallId: 'proto', messages: [] });
      results.push(`${cmd} → ${result}`);
    } catch (err) {
      results.push(`${cmd} → error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}

export const PROTOCOL_INSTRUCTIONS = `You have NO tools. The ONLY way to do anything — delegate, report, deliver, escalate,
answer — is to WRITE a literal fenced code block labeled "flotilla" into your response
text, containing a JSON object of the shape {"commands": [...]}.

READ THIS TWICE: describing an action does not perform it. Writing "I will delegate",
"the delegations are formed and ready", or "dispatching now" accomplishes NOTHING. Only
the literal characters of a \`\`\`flotilla ... \`\`\` block, actually present in your
response, are executed. If your response contains no such block, you have done nothing
and the mission stalls. Never say a command is "ready", "dispatched", or "re-issued" —
either the block is in this response, or the action has not happened.

So: whenever you decide to act, WRITE THE BLOCK NOW, in this response. Put your reasoning
first if you like, then the block. Multiple blocks are fine — the LAST one is executed,
so make your final block the complete set of commands you want run this turn.

The opening \`\`\`flotilla and closing \`\`\` must each start and end on their own line,
and you must never place a raw \`\`\` at the start of a line inside the JSON (escape
newlines in string values as \\n, so this cannot happen in valid JSON).

Each entry in "commands" has a "cmd" field plus its arguments:
  - {"cmd": "delegate", "role": "...", "charter": "...", "task": "...", "driver": "..."} (driver optional; captain only)
  - {"cmd": "report", "text": "..."} (interim progress, does not end your task; crew only)
  - {"cmd": "deliver", "text": "..."} (your complete result; ends your task)
  - {"cmd": "escalate", "question": "..."} (pauses your task until answered)
  - {"cmd": "answer", "taskId": "...", "text": "..."} (captain only, resumes a crew task)

Example:
\`\`\`flotilla
{"commands": [{"cmd": "report", "text": "starting the scan"}]}
\`\`\`

You MUST end every turn where your task is complete with a deliver command in a
flotilla block — the mission cannot proceed without it.`;
