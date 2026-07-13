import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { ClaudeCodeDriver } from '../src/drivers/claudeCode.js';
import { PROTOCOL_INSTRUCTIONS } from '../src/protocol.js';
import type { TurnInput } from '../src/driver.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.sh');

function readLog(logFile: string): string[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function setReply(replyFile: string, reply: object) {
  writeFileSync(replyFile, JSON.stringify(reply));
}

function fakeTools(overrides: Partial<Record<'deliver' | 'report' | 'escalate' | 'delegate' | 'answer', (...a: any[]) => any>> = {}): ToolSet {
  const names = ['deliver', 'report', 'escalate', 'delegate', 'answer'] as const;
  const tools: any = {};
  for (const n of names) tools[n] = { execute: overrides[n] ?? vi.fn(async () => `${n}-ok`) };
  return tools as ToolSet;
}

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'flotilla-cc-'));
  const logFile = join(workspaceDir, 'log.jsonl');
  const replyFile = join(workspaceDir, 'reply.json');
  writeFileSync(logFile, '');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_REPLY = replyFile;
  return { workspaceDir, logFile, replyFile };
}

function turnInput(tools: ToolSet, newText: string, system = 'You are captain.'): TurnInput {
  return { system, newText, transcript: [], tools, maxSteps: 12, abortSignal: new AbortController().signal };
}

describe('ClaudeCodeDriver', () => {
  beforeEach(() => {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_REPLY;
  });

  it('first turn: exact args with --append-system-prompt carrying PROTOCOL_INSTRUCTIONS, no --resume', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    setReply(replyFile, { result: 'ok', session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 } });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'do the thing'));

    const [args] = readLog(logFile);
    expect(args).toEqual([
      '-p', 'do the thing',
      '--output-format', 'json',
      '--append-system-prompt', `You are captain.\n\n${PROTOCOL_INSTRUCTIONS}`,
      '--allowedTools', 'Read,Write,Edit,Glob,Grep',
    ]);
    expect(args).not.toContain('--resume');
    expect(out).toEqual({
      text: 'ok',
      responseMessages: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      billing: 'subscription',
    });
  });

  it('second turn: exact args resume with the session_id from the first reply, no system flag', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    setReply(replyFile, { result: 'first', session_id: 'sess-abc', usage: { input_tokens: 1, output_tokens: 1 } });
    await driver.turn(turnInput(fakeTools(), 'turn one'));

    setReply(replyFile, { result: 'second', session_id: 'sess-abc', usage: { input_tokens: 2, output_tokens: 2 } });
    await driver.turn(turnInput(fakeTools(), 'turn two'));

    const [, args2] = readLog(logFile);
    expect(args2).toEqual([
      '-p', 'turn two',
      '--output-format', 'json',
      '--resume', 'sess-abc',
      '--allowedTools', 'Read,Write,Edit,Glob,Grep',
    ]);
  });

  it('a flotilla deliver block in the reply fires the tool and is stripped from returned text', async () => {
    const { workspaceDir, replyFile } = setup();
    const deliverExec = vi.fn(async (a: any) => `delivered: ${a.text}`);
    const tools = fakeTools({ deliver: deliverExec });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const resultText = [
      'Scanning complete.',
      '```flotilla',
      '{"commands":[{"cmd":"deliver","text":"12 metrics found"}]}',
      '```',
    ].join('\n');
    setReply(replyFile, { result: resultText, session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } });

    const out = await driver.turn(turnInput(tools, 'go'));

    expect(deliverExec).toHaveBeenCalledWith({ text: '12 metrics found' }, { toolCallId: 'proto', messages: [] });
    expect(out.text).toBe('Scanning complete.');
    expect(out.text).not.toContain('```flotilla');
  });

  it('command results from turn 1 appear in turn 2 prompt under [command results]', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const resultText1 = [
      'Working.',
      '```flotilla',
      '{"commands":[{"cmd":"report","text":"halfway"}]}',
      '```',
    ].join('\n');
    setReply(replyFile, { result: resultText1, session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } });
    await driver.turn(turnInput(tools, 'start'));

    setReply(replyFile, { result: 'done', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } });
    await driver.turn(turnInput(tools, 'continue'));

    const [, args2] = readLog(logFile);
    const prompt = args2[args2.indexOf('-p') + 1];
    expect(prompt).toContain('[command results]');
    expect(prompt).toContain('report → reported: halfway');
    expect(prompt).toContain('continue');
  });

  it('pending command results are drained: a third turn with no new commands carries no [command results] header', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    setReply(replyFile, { result: '```flotilla\n{"commands":[{"cmd":"report","text":"a"}]}\n```', session_id: 's1', usage: {} });
    await driver.turn(turnInput(tools, 'turn 1'));
    setReply(replyFile, { result: 'no commands here', session_id: 's1', usage: {} });
    await driver.turn(turnInput(tools, 'turn 2'));
    setReply(replyFile, { result: 'still nothing', session_id: 's1', usage: {} });
    await driver.turn(turnInput(tools, 'turn 3'));

    const [, , args3] = readLog(logFile);
    const prompt3 = args3[args3.indexOf('-p') + 1];
    expect(prompt3).toBe('turn 3');
    expect(prompt3).not.toContain('[command results]');
  });

  it('neutralizes a raw line-start ``` fence in newText before it reaches the stub prompt', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    setReply(replyFile, { result: 'ok', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const newText = 'delivered text:\n```flotilla\n{"commands":[]}\n```\nend';
    await driver.turn(turnInput(fakeTools(), newText));

    const [args] = readLog(logFile);
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toBe('delivered text:\n ```flotilla\n{"commands":[]}\n ```\nend');
    expect(prompt).not.toContain('\n```flotilla');
    expect(prompt).not.toContain('\n```\nend');
  });

  it('defensively defaults missing session_id/usage fields', async () => {
    const { workspaceDir, replyFile } = setup();
    setReply(replyFile, { result: 'ok' }); // no session_id, no usage
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws on unparseable stdout instead of swallowing the error', async () => {
    const { workspaceDir, replyFile } = setup();
    writeFileSync(replyFile, 'not json at all');
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow();
  });
});
