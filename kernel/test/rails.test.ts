import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { AiSdkDriver } from '../src/driver.js';
import { scriptedModel, apiConfig } from './helpers.js';

describe('rails', () => {
  it('fails the mission when the budget cap is hit', async () => {
    // pricing that makes the first usage event blow the cap
    const cfg = { ...apiConfig(), budgetUsd: 0.000001 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { text: 'awaiting' },
      { text: 'never reached' },
    ]);
    let first = true;
    const mission = new Mission('x', cfg, {
      driverFactory: () => new AiSdkDriver(first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }])),
    });
    const res = await mission.start();
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('budget-exceeded');
  });

  it('cancel() cancels a running mission', async () => {
    // a model that never finishes its "turn" — simulate with a long-hanging doGenerate
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({
      doGenerate: () => new Promise(() => {}),
    });
    const mission = new Mission('x', defaultConfig(), { driverFactory: () => new AiSdkDriver(hanging as any) });
    const p = mission.start();
    setTimeout(() => mission.cancel('operator kill'), 30);
    const res = await p;
    expect(res.status).toBe('canceled');
    expect(res.reason).toBe('operator kill');
    expect(mission.state().status).toBe('canceled');
  });

  it('mission timeout cancels via fake timers', async () => {
    vi.useFakeTimers();
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({ doGenerate: () => new Promise(() => {}) });
    const cfg = { ...defaultConfig(), missionTimeoutMs: 60_000 };
    const mission = new Mission('x', cfg, { driverFactory: () => new AiSdkDriver(hanging as any) });
    const p = mission.start();
    await vi.advanceTimersByTimeAsync(61_000);
    const res = await p;
    expect(res.status).toBe('canceled');
    expect(res.reason).toBe('mission timeout');
    vi.useRealTimers();
  });

  it('watchdog escalates a silent working node to the operator', async () => {
    vi.useFakeTimers();
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({ doGenerate: () => new Promise(() => {}) });
    const cfg = { ...defaultConfig(), watchdogMs: 120_000, missionTimeoutMs: 10_000_000 };
    const mission = new Mission('x', cfg, { driverFactory: () => new AiSdkDriver(hanging as any) });
    const seen: any[] = [];
    mission.onOperatorEscalation(e => seen.push(e));
    const p = mission.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(seen.length).toBe(1);
    expect(seen[0].text).toContain('watchdog');
    // watchdog escalations are answerable: the task pauses and an ANSWER resumes it
    expect(mission.state().tasks[seen[0].taskId].state).toBe('input-required');
    mission.answerEscalation(seen[0].taskId, 'keep going');
    expect(mission.state().tasks[seen[0].taskId].state).toBe('working');
    mission.cancel('cleanup');
    await p;
    vi.useRealTimers();
  });

  it('a refused delegate leaves a tool.called audit event', async () => {
    const cfg = { ...apiConfig(), maxChildren: 0 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { text: 'FINAL: no crew' },
    ]);
    const mission = new Mission('x', cfg, { driverFactory: () => new AiSdkDriver(captain) });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    const audit = mission.log.events.filter(e => e.type === 'tool.called');
    expect(audit).toHaveLength(1);
    expect((audit[0].data as any).outcome).toBe('refused: max children reached');
  });

  it('turn cap escalates to the operator once maxTurnsPerNode is exhausted', async () => {
    const cfg = { ...defaultConfig(), maxTurnsPerNode: 0 };
    const captain = scriptedModel([{ text: 'never reached' }]);
    const mission = new Mission('x', cfg, { driverFactory: () => new AiSdkDriver(captain) });
    const seen: any[] = [];
    mission.onOperatorEscalation(e => seen.push(e));
    const p = mission.start();
    await new Promise(r => setTimeout(r, 10));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].text).toContain('TurnCapError');
    mission.cancel('cleanup');
    await p;
  });

  it('ANSWER to an unknown or non-escalated task is ignored', async () => {
    const captain = scriptedModel([
      { toolName: 'escalate', input: { question: 'which scope?' } },
      { text: 'awaiting' },
      { text: 'FINAL: scoped' },
    ]);
    const mission = new Mission('x', apiConfig(), { driverFactory: () => new AiSdkDriver(captain) });
    mission.onOperatorEscalation(e => {
      mission.answerEscalation('t-phantom', 'lost');   // guard must drop this
      setTimeout(() => mission.answerEscalation(e.taskId, 'real answer'), 10);
    });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(mission.state().tasks['t-phantom']).toBeUndefined();
  });
});
