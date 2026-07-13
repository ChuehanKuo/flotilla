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
// WHY the closing fence must begin a line (\n```): inside valid JSON, newlines in string
// values are \n escapes, so a line-start ``` can never occur within the payload — an
// embedded "``` code ```" in delivered text cannot truncate the block. Inline
// single-line blocks no longer match (acceptable: they fall through to no commands).
const FENCE_RE = /```flotilla\s*\n([\s\S]*?)\n```/g;

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

export const PROTOCOL_INSTRUCTIONS = `To act, end your response with a single fenced code block labeled "flotilla" containing
a JSON object of the shape {"commands": [...]}. Only the LAST such block in your response
is read — everything else is your own reasoning and is ignored by the protocol parser.
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
