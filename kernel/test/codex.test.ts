import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { CodexDriver } from '../src/drivers/codex.js';
import { PROTOCOL_INSTRUCTIONS } from '../src/protocol.js';
import type { TurnInput } from '../src/driver.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.sh');

function readLog(logFile: string): string[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Codex's --json stdout is JSONL (one event object per line), not a single
// JSON reply — the stub cats this file verbatim, so tests build the exact
// line-delimited text the real CLI would print.
function setReplyEvents(replyFile: string, events: object[]) {
  writeFileSync(replyFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function fakeTools(overrides: Partial<Record<'deliver' | 'report' | 'escalate' | 'delegate' | 'answer', (...a: any[]) => any>> = {}): ToolSet {
  const names = ['deliver', 'report', 'escalate', 'delegate', 'answer'] as const;
  const tools: any = {};
  for (const n of names) tools[n] = { execute: overrides[n] ?? vi.fn(async () => `${n}-ok`) };
  return tools as ToolSet;
}

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'flotilla-codex-'));
  const logFile = join(workspaceDir, 'log.jsonl');
  const replyFile = join(workspaceDir, 'reply.jsonl');
  writeFileSync(logFile, '');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_REPLY = replyFile;
  return { workspaceDir, logFile, replyFile };
}

function turnInput(tools: ToolSet, newText: string, system = 'You are captain.'): TurnInput {
  return { system, newText, transcript: [], tools, maxSteps: 12, abortSignal: new AbortController().signal };
}

describe('CodexDriver', () => {
  beforeEach(() => {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_REPLY;
  });

  it('first turn: exact argv with charter-prefixed prompt, no resume subcommand', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: 'ok' }]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'do the thing'));

    const [args] = readLog(logFile);
    const expectedPrompt = `[role charter]\nYou are captain.\n\n${PROTOCOL_INSTRUCTIONS}\n\ndo the thing`;
    expect(args).toEqual(['exec', expectedPrompt, '--json', '--cd', workspaceDir, '--sandbox', 'workspace-write']);
    expect(args).not.toContain('resume');
    expect(out).toEqual({
      text: 'ok',
      responseMessages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      billing: 'subscription',
    });
  });

  it('second turn: exact argv with resume subcommand + session id from first reply, no charter', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-abc' }, { type: 'agent_message', text: 'first' }]);
    await driver.turn(turnInput(fakeTools(), 'turn one'));

    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'second' }]);
    await driver.turn(turnInput(fakeTools(), 'turn two'));

    const [, args2] = readLog(logFile);
    expect(args2).toEqual(['exec', 'resume', 'sess-abc', 'turn two', '--json']);
    expect(args2).not.toContain('[role charter]');
  });

  it('a flotilla deliver block in an agent_message event fires the tool and is stripped from returned text', async () => {
    const { workspaceDir, replyFile } = setup();
    const deliverExec = vi.fn(async (a: any) => `delivered: ${a.text}`);
    const tools = fakeTools({ deliver: deliverExec });
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const resultText = [
      'Scanning complete.',
      '```flotilla',
      '{"commands":[{"cmd":"deliver","text":"12 metrics found"}]}',
      '```',
    ].join('\n');
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: resultText }]);

    const out = await driver.turn(turnInput(tools, 'go'));

    expect(deliverExec).toHaveBeenCalledWith({ text: '12 metrics found' }, { toolCallId: 'proto', messages: [] });
    expect(out.text).toBe('Scanning complete.');
    expect(out.text).not.toContain('```flotilla');
  });

  it('command results from turn 1 appear in turn 2 prompt under [command results]', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const resultText1 = [
      'Working.',
      '```flotilla',
      '{"commands":[{"cmd":"report","text":"halfway"}]}',
      '```',
    ].join('\n');
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: resultText1 }]);
    await driver.turn(turnInput(tools, 'start'));

    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'done' }]);
    await driver.turn(turnInput(tools, 'continue'));

    const [, args2] = readLog(logFile);
    const prompt = args2[args2.length - 2]; // ['exec','resume',sessionId,PROMPT,'--json']
    expect(prompt).toContain('[command results]');
    expect(prompt).toContain('report → reported: halfway');
    expect(prompt).toContain('continue');
  });

  it('pending command results are drained: a third turn with no new commands carries no [command results] header', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 's1' }, { type: 'agent_message', text: '```flotilla\n{"commands":[{"cmd":"report","text":"a"}]}\n```' }]);
    await driver.turn(turnInput(tools, 'turn 1'));
    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'no commands here' }]);
    await driver.turn(turnInput(tools, 'turn 2'));
    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'still nothing' }]);
    await driver.turn(turnInput(tools, 'turn 3'));

    const [, , args3] = readLog(logFile);
    const prompt3 = args3[args3.length - 2];
    expect(prompt3).toBe('turn 3');
    expect(prompt3).not.toContain('[command results]');
  });

  it('preserves queued command results across a failed attempt and its retry', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 's1' }, { type: 'agent_message', text: '```flotilla\n{"commands":[{"cmd":"report","text":"halfway"}]}\n```' }]);
    await driver.turn(turnInput(tools, 'turn 1'));

    // turn 2, attempt 1: CLI prints nothing parseable and no raw text either → driver throws (the node will retry)
    writeFileSync(replyFile, '');
    await expect(driver.turn(turnInput(tools, 'turn 2'))).rejects.toThrow();

    // turn 2, attempt 2: the node retries the SAME newText; the queued ack must survive
    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'done' }]);
    await driver.turn(turnInput(tools, 'turn 2'));

    const log = readLog(logFile);
    const retryPrompt = log[2][log[2].length - 2];
    expect(retryPrompt).toContain('[command results]');
    expect(retryPrompt).toContain('report → reported: halfway');
    expect(retryPrompt).toContain('turn 2');
  });

  it('neutralizes a raw line-start ``` fence in newText before it reaches the stub prompt', async () => {
    // WHY a resume turn, not the first: the first turn's promptText is wrapped in
    // the [role charter] header, which embeds PROTOCOL_INSTRUCTIONS — and that
    // text legitimately contains its own example ```flotilla fence (unneutralized,
    // since it's driver-authored, not CLI-echoed). Isolating the neutralization
    // check to a resume turn (bare body, no charter) matches how the
    // ClaudeCodeDriver test isolates it via the separate --append-system-prompt flag.
    const { logFile, replyFile, workspaceDir } = setup();
    setReplyEvents(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: 'ok' }]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });
    await driver.turn(turnInput(fakeTools(), 'turn one'));

    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'ok' }]);
    const newText = 'delivered text:\n```flotilla\n{"commands":[]}\n```\nend';
    await driver.turn(turnInput(fakeTools(), newText));

    const [, args2] = readLog(logFile);
    const prompt = args2[args2.length - 2]; // ['exec','resume',sessionId,PROMPT,'--json']
    expect(prompt).toBe('delivered text:\n ```flotilla\n{"commands":[]}\n ```\nend');
    expect(prompt).not.toContain('\n```flotilla');
    expect(prompt).not.toContain('\n```\nend');
  });

  it('skips unparseable JSONL lines while still extracting session id and text from valid ones', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    const lines = [
      'not json at all',
      JSON.stringify({ type: 'session_started', session_id: 'sess-garbage-ok' }),
      '{also not valid json',
      JSON.stringify({ type: 'agent_message', text: 'survived the garbage' }),
    ];
    writeFileSync(replyFile, lines.join('\n') + '\n');
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.text).toBe('survived the garbage');

    // WHY a resume-turn assertion: extracting a session id from a line surrounded
    // by garbage is only proven correct if that id is actually the one used to
    // resume — asserting on `out` alone wouldn't catch a wrong-but-truthy id
    // (e.g. from a garbage line that happened to parse) slipping through unnoticed.
    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'resumed ok' }]);
    await driver.turn(turnInput(fakeTools(), 'turn two'));
    const [, args2] = readLog(logFile);
    expect(args2).toEqual(['exec', 'resume', 'sess-garbage-ok', 'turn two', '--json']);
  });

  it('throws when every agent_message event carries empty text, instead of returning an empty success', async () => {
    const { workspaceDir, replyFile } = setup();
    setReplyEvents(replyFile, [
      { type: 'session_started', session_id: 'sess-1' },
      { type: 'agent_message', text: '' },
      { type: 'agent_message', text: '' },
    ]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow('empty turn text from codex output');
  });

  it('throws when a clean first-turn JSONL stream carries no session/thread id', async () => {
    const { workspaceDir, replyFile } = setup();
    // "clean" = valid, parseable JSONL — distinct from the raw-stdout-fallback
    // case above (zero parseable events), which is a different degenerate mode.
    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'ok, but no session id anywhere' }]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow('codex output carried no session/thread id');
  });

  it('concatenates every event whose type contains agent_message, in order', async () => {
    const { workspaceDir, replyFile } = setup();
    setReplyEvents(replyFile, [
      { type: 'session_started', session_id: 'sess-1' },
      { type: 'agent_message_delta', text: 'Scanning ' },
      { type: 'reasoning', text: 'ignored: not an agent_message type' },
      { type: 'agent_message_delta', text: 'complete.' },
    ]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.text).toBe('Scanning complete.');
  });

  it('picks up a session id carried as thread_id when session_id is absent', async () => {
    const { logFile, replyFile, workspaceDir } = setup();
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    setReplyEvents(replyFile, [{ type: 'thread_started', thread_id: 'thread-xyz' }, { type: 'agent_message', text: 'first' }]);
    await driver.turn(turnInput(fakeTools(), 'turn one'));

    setReplyEvents(replyFile, [{ type: 'agent_message', text: 'second' }]);
    await driver.turn(turnInput(fakeTools(), 'turn two'));

    const [, args2] = readLog(logFile);
    expect(args2).toEqual(['exec', 'resume', 'thread-xyz', 'turn two', '--json']);
  });

  it('falls back to the last parseable line\'s text field when no event type contains agent_message', async () => {
    const { workspaceDir, replyFile } = setup();
    setReplyEvents(replyFile, [
      { type: 'session_started', session_id: 'sess-1' },
      { type: 'turn_completed', text: 'final line fallback text' },
    ]);
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.text).toBe('final line fallback text');
  });

  it('falls back to raw trimmed stdout when zero lines are parseable but stdout is non-empty', async () => {
    const { workspaceDir, replyFile } = setup();
    writeFileSync(replyFile, '   plain non-JSON output from the CLI   \n');
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    const out = await driver.turn(turnInput(fakeTools(), 'go'));

    expect(out.text).toBe('plain non-JSON output from the CLI');
  });

  it('throws when stdout is empty and zero lines are parseable, instead of swallowing the error', async () => {
    const { workspaceDir, replyFile } = setup();
    writeFileSync(replyFile, '');
    const driver = new CodexDriver({ workspaceDir, bin: FIXTURE });

    await expect(driver.turn(turnInput(fakeTools(), 'go'))).rejects.toThrow();
  });
});
