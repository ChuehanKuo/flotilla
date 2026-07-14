import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { AiSdkDriver } from '../src/driver.js';
import { scriptedModel } from './helpers.js';

describe('Mission happy path', () => {
  it('captain delegates to two crew, crew deliver, mission completes with synthesis', async () => {
    const refs: any[] = [];
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'scan-a', charter: 'Scan A.', task: 'scan A', provider: 'anthropic' } },
      { toolName: 'delegate', input: { role: 'scan-b', charter: 'Scan B.', task: 'scan B', provider: 'openai' } },
      { text: 'awaiting crew' },
      { text: 'FINAL BRIEF: A+B synthesized' },
    ]);
    const driverFactory = (ref: any) => {
      if (refs.length === 0) { refs.push(ref); return new AiSdkDriver(captain); }
      refs.push(ref);
      return new AiSdkDriver(scriptedModel([{ toolName: 'deliver', input: { text: `result for ${ref.provider}` } }, { text: '' }]));
    };
    const mission = new Mission('survey fairness metrics', defaultConfig(), { driverFactory });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL BRIEF: A+B synthesized');
    // captain defaults to claude-code; both crew were delegated onto the api driver
    expect(refs.map((r: any) => r.driver)).toEqual(['claude-code', 'api', 'api']);
    expect(refs.slice(1).map((r: any) => r.provider)).toEqual(['anthropic', 'openai']);
    expect(refs.slice(1).map((r: any) => r.model)).toEqual(['claude-sonnet-5', 'gpt-5.6-sol']);
    const s = mission.state();
    expect(Object.keys(s.nodes)).toHaveLength(3); // captain + 2 crew
    expect(s.totalCostUsd).toBeGreaterThan(0);
    expect(s.tasks['t1'].state).toBe('completed');
  });

  it('escalation reaches the operator and an answer resumes the branch', async () => {
    const captain = scriptedModel([
      { toolName: 'escalate', input: { question: 'which venue scope?' } },
      { text: 'awaiting operator' },
      { text: 'FINAL: scoped brief' },
    ]);
    const mission = new Mission('do a thing', defaultConfig(), { driverFactory: () => new AiSdkDriver(captain) });
    const escalations: any[] = [];
    mission.onOperatorEscalation(e => {
      escalations.push(e);
      setTimeout(() => mission.answerEscalation(e.taskId, 'scope to ICU only'), 10);
    });
    const res = await mission.start();
    expect(escalations).toEqual([{ taskId: 't1', from: 'captain', text: 'which venue scope?' }]);
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL: scoped brief');
  });

  it('delegate({driver:"api"}) with no provider resolves a concrete provider+model, not undefined', async () => {
    const refs: any[] = [];
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't', driver: 'api' } },
      { text: 'FINAL: done' },
    ]);
    let first = true;
    const driverFactory = (ref: any) => {
      refs.push(ref);
      return new AiSdkDriver(first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }]));
    };
    const mission = new Mission('x', defaultConfig(), { driverFactory });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(refs[1]).toEqual({ driver: 'api', provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('delegate is refused beyond maxChildren', async () => {
    const cfg = { ...defaultConfig(), maxChildren: 1 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { toolName: 'delegate', input: { role: 'b', charter: 'c', task: 't' } },
      { text: 'FINAL: done with one crew' },
    ]);
    // first driverFactory call is the captain, later calls are crew
    let first = true;
    const mission = new Mission('x', cfg, {
      driverFactory: () => new AiSdkDriver(first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }])),
    });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    const s = mission.state();
    expect(Object.keys(s.nodes)).toHaveLength(2); // captain + only 1 crew
  });

  it('a relative missionsDir still yields a workspace crew file tools can actually write into (workspaceDir resolved absolute)', async () => {
    // WHY relative missionsDir: resolveSafe (tools/files.ts) compares an absolute
    // resolve(workspaceDir, path) against workspaceDir itself — if workspaceDir is
    // left relative, that comparison can never match and every file op is rejected
    // as "path escapes workspace". A relative missionsDir here reproduces exactly
    // that path, regardless of what directory the test runner's cwd happens to be.
    const relDir = `relmiss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'writer', charter: 'Write a file.', task: 'write it' } },
      { text: 'FINAL: done' },
    ]);
    let first = true;
    const driverFactory = () =>
      new AiSdkDriver(first
        ? ((first = false), captain)
        : scriptedModel([
            { toolName: 'write_file', input: { path: 'note.txt', content: 'hi' } },
            { toolName: 'deliver', input: { text: 'wrote it' } },
            { text: '' },
          ]));
    const mission = new Mission('x', defaultConfig(), { driverFactory, missionsDir: relDir });
    try {
      const res = await mission.start();
      expect(res.status).toBe('completed');
      const written = readFileSync(join(relDir, mission.id, 'workspace', 'note.txt'), 'utf8');
      expect(written).toBe('hi');
    } finally {
      rmSync(relDir, { recursive: true, force: true });
    }
  });
});
