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

// Builds one stream-json "assistant" event line whose message content is a
// single text block — the shape verified against the installed CLI
// (2.1.207) via a non-mutating `--output-format stream-json --verbose` probe.
function assistantEvent(text: string, sessionId?: string): object {
  const event: Record<string, unknown> = { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  if (sessionId) event.session_id = sessionId;
  return event;
}

// Builds one stream-json "result" event line — the final-turn summary.
function resultEvent(result: string, opts: { sessionId?: string; usage?: { input_tokens?: number; output_tokens?: number } } = {}): object {
  const event: Record<string, unknown> = { type: 'result', subtype: 'success', result };
  if (opts.sessionId) event.session_id = opts.sessionId;
  if (opts.usage) event.usage = opts.usage;
  return event;
}

function setStreamReply(replyFile: string, events: object[]) {
  writeFileSync(replyFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
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
  const replyFile = join(workspaceDir, 'reply.ndjson');
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

  it('first turn: exact args with stream-json/verbose output format, --append-system-prompt carrying PROTOCOL_INSTRUCTIONS, no --resume', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    setStreamReply(replyFile, [
      assistantEvent('ok', 'sess-1'),
      resultEvent('ok', { sessionId: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'do the thing'));

    const [args] = readLog(logFile);
    expect(args).toEqual([
      '-p', 'do the thing',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', `You are captain.\n\n${PROTOCOL_INSTRUCTIONS}`,
      '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
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

    setStreamReply(replyFile, [assistantEvent('first', 'sess-abc'), resultEvent('first', { sessionId: 'sess-abc', usage: { input_tokens: 1, output_tokens: 1 } })]);
    await driver.turn(turnInput(fakeTools(), 'turn one'));

    setStreamReply(replyFile, [assistantEvent('second', 'sess-abc'), resultEvent('second', { sessionId: 'sess-abc', usage: { input_tokens: 2, output_tokens: 2 } })]);
    await driver.turn(turnInput(fakeTools(), 'turn two'));

    const [, args2] = readLog(logFile);
    expect(args2).toEqual([
      '-p', 'turn two',
      '--output-format', 'stream-json',
      '--verbose',
      '--resume', 'sess-abc',
      '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
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
    setStreamReply(replyFile, [assistantEvent(resultText, 'sess-1'), resultEvent(resultText, { sessionId: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } })]);

    const out = await driver.turn(turnInput(tools, 'go'));

    expect(deliverExec).toHaveBeenCalledWith({ text: '12 metrics found' }, { toolCallId: 'proto', messages: [] });
    expect(out.text).toBe('Scanning complete.');
    expect(out.text).not.toContain('```flotilla');
  });

  it('BUG REPRO: a flotilla block in an intermediate assistant turn executes even when the final result is pure narration with no block', async () => {
    const { workspaceDir, replyFile } = setup();
    const delegateExec = vi.fn(async (a: any) => `delegated: ${a.role}`);
    const tools = fakeTools({ delegate: delegateExec });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    // Headless Claude's internal multi-turn loop: turn 1 emits the command
    // block, but its FINAL turn (and therefore `result`) is just narration
    // re-affirming it already sent the block — no block present there. A
    // `parseCommands(result)`-only implementation sees no block and the
    // captain never delegates; this is the exact bug this task fixes.
    const turn1 = [
      'I will delegate this now.',
      '```flotilla',
      '{"commands":[{"cmd":"delegate","role":"scout","charter":"find the bug","task":"scan the logs"}]}',
      '```',
    ].join('\n');
    const narration = 'Re-issuing the block from my previous turn — delegation already sent.';

    setStreamReply(replyFile, [
      assistantEvent(turn1, 'sess-1'),
      assistantEvent(narration, 'sess-1'),
      resultEvent(narration, { sessionId: 'sess-1', usage: { input_tokens: 3, output_tokens: 3 } }),
    ]);

    const out = await driver.turn(turnInput(tools, 'go'));

    expect(delegateExec).toHaveBeenCalledWith(
      { role: 'scout', charter: 'find the bug', task: 'scan the logs' },
      { toolCallId: 'proto', messages: [] },
    );
    expect(out.text).toBe(narration);
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
    setStreamReply(replyFile, [assistantEvent(resultText1, 'sess-1'), resultEvent(resultText1, { sessionId: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } })]);
    await driver.turn(turnInput(tools, 'start'));

    setStreamReply(replyFile, [assistantEvent('done', 'sess-1'), resultEvent('done', { sessionId: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } })]);
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

    const t1 = '```flotilla\n{"commands":[{"cmd":"report","text":"a"}]}\n```';
    setStreamReply(replyFile, [assistantEvent(t1, 's1'), resultEvent(t1, { sessionId: 's1' })]);
    await driver.turn(turnInput(tools, 'turn 1'));
    setStreamReply(replyFile, [assistantEvent('no commands here', 's1'), resultEvent('no commands here', { sessionId: 's1' })]);
    await driver.turn(turnInput(tools, 'turn 2'));
    setStreamReply(replyFile, [assistantEvent('still nothing', 's1'), resultEvent('still nothing', { sessionId: 's1' })]);
    await driver.turn(turnInput(tools, 'turn 3'));

    const [, , args3] = readLog(logFile);
    const prompt3 = args3[args3.indexOf('-p') + 1];
    expect(prompt3).toBe('turn 3');
    expect(prompt3).not.toContain('[command results]');
  });

  it('preserves queued command results across a failed attempt and its retry', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const t1 = '```flotilla\n{"commands":[{"cmd":"report","text":"halfway"}]}\n```';
    setStreamReply(replyFile, [assistantEvent(t1, 's1'), resultEvent(t1, { sessionId: 's1' })]);
    await driver.turn(turnInput(tools, 'turn 1'));

    // turn 2, attempt 1: CLI prints garbage → driver throws (the node will retry)
    writeFileSync(replyFile, 'garbage not json\nnot json either\n');
    await expect(driver.turn(turnInput(tools, 'turn 2'))).rejects.toThrow();

    // turn 2, attempt 2: the node retries the SAME newText; the queued ack must survive
    setStreamReply(replyFile, [assistantEvent('done', 's1'), resultEvent('done', { sessionId: 's1' })]);
    await driver.turn(turnInput(tools, 'turn 2'));

    const log = readLog(logFile);
    const retryPrompt = log[2][log[2].indexOf('-p') + 1];
    expect(retryPrompt).toContain('[command results]');
    expect(retryPrompt).toContain('report → reported: halfway');
    expect(retryPrompt).toContain('turn 2');
  });

  it('neutralizes a raw line-start ``` fence in newText before it reaches the stub prompt', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    setStreamReply(replyFile, [assistantEvent('ok', 'sess-1'), resultEvent('ok', { sessionId: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } })]);
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
    setStreamReply(replyFile, [assistantEvent('ok'), resultEvent('ok')]); // no session_id, no usage anywhere
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws on unparseable stdout instead of swallowing the error', async () => {
    const { workspaceDir, replyFile } = setup();
    writeFileSync(replyFile, 'not json at all\nstill not json\n');
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow();
  });

  it('throws when the stream carries no result event and no assistant text at all', async () => {
    const { workspaceDir, replyFile } = setup();
    // valid NDJSON, but only a system event — no assistant text, no result
    setStreamReply(replyFile, [{ type: 'system', subtype: 'init', session_id: 'sess-1' }]);
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow();
  });
});
