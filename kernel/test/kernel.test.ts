import { describe, it, expect } from 'vitest';
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
});
