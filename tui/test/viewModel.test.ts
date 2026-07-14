import { describe, it, expect } from 'vitest';
import { EventLog, reduce } from '@flota/kernel';
import { fleetRows, nodeFeed, initialUi } from '../src/viewModel.js';

function fleetLog(): EventLog {
  const log = new EventLog('m-1');
  log.append('mission.started', { order: 'scan fairness metrics' });
  log.append('node.spawned', { nodeId: 'captain', role: 'captain', provider: 'anthropic', model: 'claude-sonnet-5', driver: 'claude-code', taskId: 't-captain' });
  log.append('task.state', { taskId: 't-captain', assignee: 'captain', state: 'working' });
  log.append('node.spawned', { nodeId: 'crew-1', parentId: 'captain', role: 'metrics-scan', provider: 'openai', model: 'gpt-5.6-sol', driver: 'claude-code', taskId: 't-crew-1' });
  log.append('task.state', { taskId: 't-crew-1', parentTaskId: 't-captain', assignee: 'crew-1', state: 'working' });
  log.append('node.spawned', { nodeId: 'crew-1-child', parentId: 'crew-1', role: 'subtask', provider: 'anthropic', model: 'claude-sonnet-5', driver: 'claude-code', taskId: 't-crew-1-child' });
  log.append('task.state', { taskId: 't-crew-1-child', parentTaskId: 't-crew-1', assignee: 'crew-1-child', state: 'working' });
  log.append('node.spawned', { nodeId: 'crew-2', parentId: 'captain', role: 'writeup', provider: 'anthropic', model: 'claude-sonnet-5', driver: 'claude-code', taskId: 't-crew-2' });
  log.append('task.state', { taskId: 't-crew-2', parentTaskId: 't-captain', assignee: 'crew-2', state: 'submitted' });
  log.append('usage', { nodeId: 'crew-1', costUsd: 0.5 });
  return log;
}

describe('fleetRows', () => {
  it('orders captain first, then each node\'s children depth-first, with correct depth and isCaptain', () => {
    const s = reduce(fleetLog().events);
    const rows = fleetRows(s);
    expect(rows.map(r => r.id)).toEqual(['captain', 'crew-1', 'crew-1-child', 'crew-2']);
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2, 1]);
    expect(rows.map(r => r.isCaptain)).toEqual([true, false, false, false]);
  });

  it('carries role, driver, state and cost through', () => {
    const s = reduce(fleetLog().events);
    const rows = fleetRows(s);
    const crew1 = rows.find(r => r.id === 'crew-1')!;
    expect(crew1.role).toBe('metrics-scan');
    expect(crew1.driver).toBe('claude-code');
    expect(crew1.state).toBe('working');
    expect(crew1.costUsd).toBeCloseTo(0.5);
  });
});

describe('nodeFeed', () => {
  it('includes only the target node\'s messages (from OR to it), usage and task.state lines', () => {
    const log = fleetLog();
    log.append('message', { kind: 'ORDER', from: 'captain', to: 'crew-1', taskId: 't-crew-1', text: 'scan the metrics' });
    log.append('message', { kind: 'INSTRUCT', from: 'operator', to: 'crew-1', taskId: 't-crew-1', text: 'focus on ICU cohort' });
    log.append('message', { kind: 'REPORT', from: 'crew-1', to: 'captain', taskId: 't-crew-1', text: 'progress so far' });
    log.append('message', { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't-crew-1', text: 'found 12 metrics' });
    // unrelated: a message entirely between captain and crew-2 must not leak into crew-1's feed
    log.append('message', { kind: 'ORDER', from: 'captain', to: 'crew-2', taskId: 't-crew-2', text: 'write it up' });
    log.append('task.state', { taskId: 't-crew-1', state: 'completed' });

    const events = log.events;
    const feed = nodeFeed(events, 'crew-1');

    expect(feed.some(l => l.includes('scan the metrics'))).toBe(true);
    expect(feed.some(l => l.includes('focus on ICU cohort'))).toBe(true); // INSTRUCT to it
    expect(feed.some(l => l.includes('progress so far'))).toBe(true);
    expect(feed.some(l => l.includes('found 12 metrics'))).toBe(true);
    expect(feed.some(l => l.includes('0.5'))).toBe(true); // usage line
    expect(feed.some(l => l.includes('completed'))).toBe(true); // task.state line

    expect(feed.some(l => l.includes('write it up'))).toBe(false); // crew-2's order, excluded
  });

  it('excludes another node\'s feed entirely', () => {
    const log = fleetLog();
    log.append('message', { kind: 'ORDER', from: 'captain', to: 'crew-2', taskId: 't-crew-2', text: 'write it up' });
    const feed = nodeFeed(log.events, 'crew-1-child');
    expect(feed.some(l => l.includes('write it up'))).toBe(false);
  });
});

describe('initialUi', () => {
  it('starts in browse mode, empty input, no selection', () => {
    expect(initialUi()).toEqual({ mode: 'browse', input: '', selectedNodeId: undefined });
  });
});
