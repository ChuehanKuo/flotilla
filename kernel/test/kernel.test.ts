import { describe, it, expect } from 'vitest';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { scriptedModel } from './helpers.js';

describe('Mission happy path', () => {
  it('captain delegates to two crew, crew deliver, mission completes with synthesis', async () => {
    const models: any[] = [];
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'scan-a', charter: 'Scan A.', task: 'scan A', provider: 'anthropic' } },
      { toolName: 'delegate', input: { role: 'scan-b', charter: 'Scan B.', task: 'scan B', provider: 'openai' } },
      { text: 'awaiting crew' },
      { text: 'FINAL BRIEF: A+B synthesized' },
    ]);
    const modelFactory = (ref: any) => {
      if (models.length === 0) { models.push(ref); return captain; }
      models.push(ref);
      return scriptedModel([{ toolName: 'deliver', input: { text: `result for ${ref.provider}` } }, { text: '' }]);
    };
    const mission = new Mission('survey fairness metrics', defaultConfig(), { modelFactory });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL BRIEF: A+B synthesized');
    // both crew providers were requested as delegated
    expect(models.map((m: any) => m.provider)).toEqual(['anthropic', 'anthropic', 'openai']);
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
    const mission = new Mission('do a thing', defaultConfig(), { modelFactory: () => captain });
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
    // first modelFactory call is the captain, later calls are crew
    let first = true;
    const mission = new Mission('x', cfg, {
      modelFactory: () => (first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }])),
    });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    const s = mission.state();
    expect(Object.keys(s.nodes)).toHaveLength(2); // captain + only 1 crew
  });
});
