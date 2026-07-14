import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { CliDriver } from '../src/drivers/cliDriver.js';
import { ClaudeCodeDriver } from '../src/drivers/claudeCode.js';
import { CLAUDE_CODE_SPEC, type CliDriverSpec, type CliParseResult } from '../src/drivers/specs.js';
import { PROTOCOL_INSTRUCTIONS } from '../src/protocol.js';
import type { TurnInput } from '../src/driver.js';

// The generic stub (shared with the claude/codex suites): appends its argv to
// $FAKE_CLI_LOG as one JSON-array line, then cats $FAKE_CLI_REPLY verbatim.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.sh');

function readLog(logFile: string): string[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function fakeTools(overrides: Partial<Record<'deliver' | 'report' | 'escalate' | 'delegate' | 'answer', (...a: any[]) => any>> = {}): ToolSet {
  const names = ['deliver', 'report', 'escalate', 'delegate', 'answer'] as const;
  const tools: any = {};
  for (const n of names) tools[n] = { execute: overrides[n] ?? vi.fn(async () => `${n}-ok`) };
  return tools as ToolSet;
}

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-cli-'));
  const logFile = join(workspaceDir, 'log.jsonl');
  const replyFile = join(workspaceDir, 'reply.txt');
  writeFileSync(logFile, '');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_REPLY = replyFile;
  return { workspaceDir, logFile, replyFile };
}

function turnInput(tools: ToolSet, newText: string, system = 'You are captain.'): TurnInput {
  return { system, newText, transcript: [], tools, maxSteps: 12, abortSignal: new AbortController().signal };
}

// A minimal user-defined spec: firstArgs = ['run', prompt]; resumeArgs =
// ['resume', sessionId, prompt]; parse pulls a `SESSION=<id>` marker off the
// first line and treats the remainder as the transcript.
function customSpec(): CliDriverSpec {
  return {
    command: 'my-agent',
    firstArgs: ctx => ['run', ctx.prompt],
    resumeArgs: ctx => ['resume', ctx.sessionId as string, ctx.prompt],
    parse(stdout): CliParseResult {
      const lines = stdout.split('\n');
      let sessionId: string | undefined;
      const kept: string[] = [];
      for (const line of lines) {
        const m = /^SESSION=(\S+)$/.exec(line.trim());
        if (m) { sessionId = m[1]; continue; }
        kept.push(line);
      }
      const transcript = kept.join('\n').trim();
      if (transcript === '') throw new Error('custom spec: empty transcript');
      return { transcript, sessionId, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

describe('CliDriver (generic spec)', () => {
  beforeEach(() => {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_REPLY;
  });

  it('drives a two-turn exchange: firstArgs then resumeArgs carrying turn 1 sessionId, executes a flota block, bills subscription', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    const deliverExec = vi.fn(async (a: any) => `delivered: ${a.text}`);
    const tools = fakeTools({ deliver: deliverExec });
    const driver = new CliDriver(customSpec(), { workspaceDir, bin: FIXTURE });

    // Turn 1: establishes session s-42, plain narration (no block).
    writeFileSync(replyFile, 'SESSION=s-42\nstarting up');
    const out1 = await driver.turn(turnInput(tools, 'first task'));
    expect(out1).toEqual({
      text: 'starting up',
      responseMessages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      billing: 'subscription',
    });

    // Turn 2: resume, and a flota deliver block fires the tool + is stripped.
    const reply2 = [
      'Scanning complete.',
      '```flota',
      '{"commands":[{"cmd":"deliver","text":"12 metrics found"}]}',
      '```',
    ].join('\n');
    writeFileSync(replyFile, reply2);
    const out2 = await driver.turn(turnInput(tools, 'second task'));

    expect(deliverExec).toHaveBeenCalledWith({ text: '12 metrics found' }, { toolCallId: 'proto', messages: [] });
    expect(out2.text).toBe('Scanning complete.');
    expect(out2.text).not.toContain('```flota');
    expect(out2.billing).toBe('subscription');

    const [args1, args2] = readLog(logFile);
    expect(args1).toEqual(['run', 'first task']);
    expect(args2).toEqual(['resume', 's-42', 'second task']);
  });

  it('carries turn-1 command results into the turn-2 prompt via [command results]', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    const tools = fakeTools({ report: vi.fn(async (a: any) => `reported: ${a.text}`) });
    const driver = new CliDriver(customSpec(), { workspaceDir, bin: FIXTURE });

    writeFileSync(replyFile, 'SESSION=s1\n```flota\n{"commands":[{"cmd":"report","text":"halfway"}]}\n```');
    await driver.turn(turnInput(tools, 'start'));

    writeFileSync(replyFile, 'done');
    await driver.turn(turnInput(tools, 'continue'));

    const [, args2] = readLog(logFile);
    const prompt = args2[args2.length - 1]; // ['resume', sessionId, PROMPT]
    expect(prompt).toContain('[command results]');
    expect(prompt).toContain('report → reported: halfway');
    expect(prompt).toContain('continue');
  });

  it('ClaudeCodeDriver still produces the exact claude first-turn argv', async () => {
    const { workspaceDir, logFile, replyFile } = setup();
    writeFileSync(
      replyFile,
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, session_id: 'sess-1' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n') + '\n',
    );
    const driver = new ClaudeCodeDriver({ workspaceDir, bin: FIXTURE });
    await driver.turn(turnInput(fakeTools(), 'do the thing'));

    const [args] = readLog(logFile);
    expect(args).toEqual([
      '-p', 'do the thing',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', `You are captain.\n\n${PROTOCOL_INSTRUCTIONS}`,
      '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
    ]);
  });

  it('CLAUDE_CODE_SPEC.firstArgs output matches the claude first-turn argv shape', () => {
    const args = CLAUDE_CODE_SPEC.firstArgs({
      prompt: 'hello',
      system: 'SYS',
      workspaceDir: '/ws',
      protocol: 'PROTO',
    });
    expect(args).toEqual([
      '-p', 'hello',
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', 'SYS\n\nPROTO',
      '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
    ]);
  });
});
