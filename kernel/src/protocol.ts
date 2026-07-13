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
const FENCE_RE = /```flotilla[ \t]*\r?\n([\s\S]*?)```/g;

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

const COMMAND_TOOL: Record<Command['cmd'], string> = {
  delegate: 'delegate',
  report: 'report',
  deliver: 'deliver',
  escalate: 'escalate',
  answer: 'answer',
};

export async function executeCommands(commands: Command[], tools: ToolSet): Promise<string[]> {
  const results: string[] = [];
  for (const command of commands) {
    const { cmd, ...args } = command as Command & Record<string, unknown>;
    const toolName = COMMAND_TOOL[cmd as Command['cmd']];
    const tool = toolName ? tools[toolName] : undefined;
    if (!tool?.execute) {
      results.push(`${cmd} → error: unknown command`);
      continue;
    }
    try {
      const result = await tool.execute(args, { toolCallId: 'proto', messages: [] });
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

Each entry in "commands" has a "cmd" field plus its arguments:
  - {"cmd": "delegate", "role": "...", "charter": "...", "task": "...", "driver": "..."} (driver optional; captain only)
  - {"cmd": "report", "text": "..."} (interim progress, does not end your task)
  - {"cmd": "deliver", "text": "..."} (your complete result; ends your task)
  - {"cmd": "escalate", "question": "..."} (pauses your task until answered)
  - {"cmd": "answer", "taskId": "...", "text": "..."} (captain only, resumes a crew task)

Example:
\`\`\`flotilla
{"commands": [{"cmd": "report", "text": "starting the scan"}]}
\`\`\`

You MUST end every turn where your task is complete with a deliver command in a
flotilla block — the mission cannot proceed without it.`;
