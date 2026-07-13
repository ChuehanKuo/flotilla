import { describe, it, expect, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { parseCommands, executeCommands, PROTOCOL_INSTRUCTIONS, type Command } from '../src/protocol.js';

const opts = { toolCallId: 'proto', messages: [] as any[] };

function fakeTool(execute: (...args: any[]) => any) {
  return { execute } as any;
}

function fakeTools(overrides: Partial<Record<'delegate' | 'report' | 'deliver' | 'escalate' | 'answer', (...args: any[]) => any>> = {}): ToolSet {
  const names = ['delegate', 'report', 'deliver', 'escalate', 'answer'] as const;
  const tools: any = {};
  for (const n of names) {
    tools[n] = fakeTool(overrides[n] ?? (async () => `${n}-ok`));
  }
  return tools as ToolSet;
}

describe('parseCommands', () => {
  it('extracts the last flotilla-labeled fenced block, strips it from cleanText, returns typed commands', () => {
    const text = [
      "I'll scan A now.",
      '```flotilla',
      '{"commands":[{"cmd":"report","text":"scanning"}]}',
      '```',
      '',
    ].join('\n');
    const { commands, cleanText } = parseCommands(text);
    expect(commands).toEqual<Command[]>([{ cmd: 'report', text: 'scanning' }]);
    expect(cleanText).toContain("I'll scan A now.");
    expect(cleanText).not.toContain('```');
    expect(cleanText).not.toContain('scanning');
  });

  it('when multiple flotilla blocks are present, uses only the LAST one for commands', () => {
    const text = [
      'first thought',
      '```flotilla',
      '{"commands":[{"cmd":"report","text":"first"}]}',
      '```',
      'second thought',
      '```flotilla',
      '{"commands":[{"cmd":"deliver","text":"final"}]}',
      '```',
    ].join('\n');
    const { commands, cleanText } = parseCommands(text);
    expect(commands).toEqual<Command[]>([{ cmd: 'deliver', text: 'final' }]);
    // only the extracted (last) block is removed — earlier narration/blocks are untouched
    expect(cleanText).toContain('first thought');
    expect(cleanText).toContain('```flotilla');
    expect(cleanText).toContain('"first"');
    expect(cleanText).not.toContain('"final"');
  });

  it('handles multiple commands in one block, in order', () => {
    const text = '```flotilla\n{"commands":[{"cmd":"report","text":"a"},{"cmd":"deliver","text":"b"}]}\n```';
    const { commands } = parseCommands(text);
    expect(commands).toEqual<Command[]>([{ cmd: 'report', text: 'a' }, { cmd: 'deliver', text: 'b' }]);
  });

  it('falls through to empty commands + unchanged cleanText on invalid JSON', () => {
    const text = 'narration\n```flotilla\n{not valid json}\n```\n';
    expect(parseCommands(text)).toEqual({ commands: [], cleanText: text });
  });

  it('falls through to empty commands + unchanged cleanText when there is no fenced block', () => {
    const text = 'just narration, no fences at all';
    expect(parseCommands(text)).toEqual({ commands: [], cleanText: text });
  });

  it('falls through to empty commands + unchanged cleanText for an unlabeled or differently-labeled fenced block', () => {
    const plain = '```\n{"commands":[{"cmd":"deliver","text":"x"}]}\n```';
    expect(parseCommands(plain)).toEqual({ commands: [], cleanText: plain });
    const json = '```json\n{"commands":[{"cmd":"deliver","text":"x"}]}\n```';
    expect(parseCommands(json)).toEqual({ commands: [], cleanText: json });
  });

  it('falls through when the labeled block parses but has no commands array', () => {
    const text = '```flotilla\n{"foo":1}\n```';
    expect(parseCommands(text)).toEqual({ commands: [], cleanText: text });
  });
});

describe('executeCommands', () => {
  it('maps cmd to tool name, calls execute(argsWithoutCmd, { toolCallId: "proto", messages: [] }), collects "<cmd> → <result>"', async () => {
    const delegateExec = vi.fn(async () => 'spawned crew-1 (task t2)');
    const tools = fakeTools({ delegate: delegateExec });
    const commands: Command[] = [{ cmd: 'delegate', role: 'scan', charter: 'Scan.', task: 'scan it', driver: 'codex' }];
    const results = await executeCommands(commands, tools);
    expect(results).toEqual(['delegate → spawned crew-1 (task t2)']);
    expect(delegateExec).toHaveBeenCalledWith({ role: 'scan', charter: 'Scan.', task: 'scan it', driver: 'codex' }, opts);
  });

  it('covers all five command kinds mapping to their like-named tools', async () => {
    const report = vi.fn(async (a: any) => `reported: ${a.text}`);
    const deliver = vi.fn(async (a: any) => `delivered: ${a.text}`);
    const escalate = vi.fn(async (a: any) => `escalated: ${a.question}`);
    const answer = vi.fn(async (a: any) => `answered ${a.taskId}: ${a.text}`);
    const tools = fakeTools({ report, deliver, escalate, answer });
    const commands: Command[] = [
      { cmd: 'report', text: 'progress' },
      { cmd: 'deliver', text: 'done' },
      { cmd: 'escalate', question: 'which scope?' },
      { cmd: 'answer', taskId: 't2', text: 'yes' },
    ];
    const results = await executeCommands(commands, tools);
    expect(results).toEqual([
      'report → reported: progress',
      'deliver → delivered: done',
      'escalate → escalated: which scope?',
      'answer → answered t2: yes',
    ]);
  });

  it('unknown cmd produces an "unknown command" error string without throwing', async () => {
    const tools = fakeTools();
    const commands = [{ cmd: 'frobnicate' } as unknown as Command];
    const results = await executeCommands(commands, tools);
    expect(results).toEqual(['frobnicate → error: unknown command']);
  });

  it('a known cmd whose tool is missing from the ToolSet also errors as "unknown command"', async () => {
    const all = fakeTools();
    const { delegate, ...crewTools } = all as any;
    const commands: Command[] = [{ cmd: 'delegate', role: 'x', charter: 'y', task: 'z' }];
    const results = await executeCommands(commands, crewTools as ToolSet);
    expect(results).toEqual(['delegate → error: unknown command']);
  });

  it('a synchronously-throwing execute yields an error string and never rejects', async () => {
    const tools = fakeTools({ deliver: () => { throw new Error('boom'); } });
    const commands: Command[] = [{ cmd: 'deliver', text: 'x' }];
    await expect(executeCommands(commands, tools)).resolves.toEqual(['deliver → error: boom']);
  });

  it('an execute that returns a rejected promise yields an error string and never rejects', async () => {
    const tools = fakeTools({ escalate: async () => { throw new Error('nope'); } });
    const commands: Command[] = [{ cmd: 'escalate', question: 'q' }];
    await expect(executeCommands(commands, tools)).resolves.toEqual(['escalate → error: nope']);
  });

  it('processes multiple commands independently, mixing success and error', async () => {
    const tools = fakeTools({ deliver: () => { throw new Error('boom'); } });
    const commands: Command[] = [
      { cmd: 'report', text: 'ok' },
      { cmd: 'deliver', text: 'x' },
    ];
    const results = await executeCommands(commands, tools);
    expect(results).toEqual(['report → report-ok', 'deliver → error: boom']);
  });
});

describe('PROTOCOL_INSTRUCTIONS', () => {
  it('is non-empty and documents the fenced flotilla format and the mandatory deliver command', () => {
    expect(typeof PROTOCOL_INSTRUCTIONS).toBe('string');
    expect(PROTOCOL_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(PROTOCOL_INSTRUCTIONS).toContain('```flotilla');
    expect(PROTOCOL_INSTRUCTIONS).toContain('"commands"');
    expect(PROTOCOL_INSTRUCTIONS.toLowerCase()).toContain('deliver');
  });
});
