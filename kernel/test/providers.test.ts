import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { realModelFactory, realDriverFactory } from '../src/providers.js';
import { CliDriver } from '../src/drivers/cliDriver.js';
import type { CliDriverSpec, CliParseResult } from '../src/drivers/specs.js';
import type { NodeRef } from '../src/types.js';
import type { TurnInput } from '../src/driver.js';

describe('realModelFactory', () => {
  it('resolves both providers to model instances carrying the model id', () => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key';
    process.env.OPENAI_API_KEY ??= 'test-key';
    const a = realModelFactory({ provider: 'anthropic', model: 'claude-sonnet-5' });
    const o = realModelFactory({ provider: 'openai', model: 'gpt-5.6-sol' });
    // WHY the cast: `LanguageModel` from 'ai' is a union with GlobalProviderModelId
    // (gateway string ids), so TS won't narrow `.modelId` on the union — but the runtime
    // value here is always a LanguageModelV2 instance from anthropic()/openai().
    expect((a as { modelId: string }).modelId).toBe('claude-sonnet-5');
    expect((o as { modelId: string }).modelId).toBe('gpt-5.6-sol');
  });
});

// Reuses the generic fake-CLI stub (shared with cliDriver/claudeCode/codex
// suites): spec.command points straight at the stub script, so a successful
// turn() proves realDriverFactory actually bound the ref's spec into the
// CliDriver it constructed — not just that it returned *a* CliDriver.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.sh');

function customSpec(): CliDriverSpec {
  return {
    command: FIXTURE,
    firstArgs: ctx => ['run', ctx.prompt],
    resumeArgs: ctx => ['resume', ctx.sessionId as string, ctx.prompt],
    parse(stdout): CliParseResult {
      const transcript = stdout.trim();
      if (transcript === '') throw new Error('custom spec: empty transcript');
      return { transcript, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function fakeTools(): ToolSet {
  return { deliver: { execute: async (a: any) => `delivered: ${a.text}` } } as unknown as ToolSet;
}

describe('realDriverFactory — custom driver kind', () => {
  it('driver:"custom" with a spec yields a CliDriver bound to that spec', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-custom-'));
    const logFile = join(workspaceDir, 'log.jsonl');
    const replyFile = join(workspaceDir, 'reply.txt');
    writeFileSync(logFile, '');
    writeFileSync(replyFile, 'hello from custom cli');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_REPLY = replyFile;

    try {
      const ref: NodeRef = { driver: 'custom', spec: customSpec() };
      const driver = realDriverFactory(ref, { workspaceDir });
      expect(driver).toBeInstanceOf(CliDriver);

      const input: TurnInput = {
        system: 'sys',
        newText: 'hi',
        transcript: [],
        tools: fakeTools(),
        maxSteps: 12,
        abortSignal: new AbortController().signal,
      };
      const out = await driver.turn(input);
      expect(out.text).toBe('hello from custom cli');

      const [args] = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(args).toEqual(['run', 'hi']);
    } finally {
      delete process.env.FAKE_CLI_LOG;
      delete process.env.FAKE_CLI_REPLY;
    }
  });

  it('driver:"custom" with no spec throws a clear error', () => {
    const ref: NodeRef = { driver: 'custom' };
    expect(() => realDriverFactory(ref, { workspaceDir: '/tmp' })).toThrow('custom driver requires a spec');
  });
});
