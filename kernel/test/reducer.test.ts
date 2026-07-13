import { describe, it, expect } from 'vitest';
import { EventLog } from '../src/log.js';
import { reduce, nodeState } from '../src/reducer.js';

function sampleLog(): EventLog {
  const log = new EventLog('m-1');
  log.append('mission.started', { order: 'scan fairness metrics' });
  log.append('node.spawned', { nodeId: 'captain', role: 'captain', provider: 'anthropic', model: 'claude-sonnet-4-5', taskId: 't1' });
  log.append('task.state', { taskId: 't1', assignee: 'captain', state: 'working' });
  log.append('node.spawned', { nodeId: 'crew-1', parentId: 'captain', role: 'metrics-scan', provider: 'openai', model: 'gpt-5.1', taskId: 't2' });
  log.append('task.state', { taskId: 't2', parentTaskId: 't1', assignee: 'crew-1', state: 'working' });
  log.append('usage', { nodeId: 'crew-1', costUsd: 0.12 });
  log.append('message', { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'include non-ICU?' });
  log.append('task.state', { taskId: 't2', state: 'input-required' });
  return log;
}

describe('reduce', () => {
  it('projects nodes, tasks, escalations, cost', () => {
    const s = reduce(sampleLog().events);
    expect(s.status).toBe('running');
    expect(s.order).toBe('scan fairness metrics');
    expect(Object.keys(s.nodes)).toEqual(['captain', 'crew-1']);
    expect(s.nodes['crew-1'].parentId).toBe('captain');
    expect(s.tasks['t2'].state).toBe('input-required');
    expect(s.openEscalations).toEqual([{ taskId: 't2', from: 'crew-1', text: 'include non-ICU?' }]);
    expect(s.totalCostUsd).toBeCloseTo(0.12);
    expect(nodeState(s, 'crew-1')).toBe('input-required');
  });

  it('ANSWER clears the escalation; DELIVER completes; mission terminates', () => {
    const log = sampleLog();
    log.append('message', { kind: 'ANSWER', from: 'captain', to: 'crew-1', taskId: 't2', text: 'yes, include' });
    log.append('task.state', { taskId: 't2', state: 'working' });
    log.append('message', { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'found 12 metrics' });
    log.append('task.state', { taskId: 't2', state: 'completed' });
    log.append('mission.completed', { result: 'brief text' });
    const s = reduce(log.events);
    expect(s.openEscalations).toEqual([]);
    expect(s.tasks['t2'].state).toBe('completed');
    expect(s.status).toBe('completed');
    expect(s.result).toBe('brief text');
  });
});
