import { describe, it, expect } from 'vitest';
import { reduce, type FleetEvent } from '@flota/kernel';
import { projectGraph, layout } from '../src/graph.js';

function ev(seq: number, type: FleetEvent['type'], data: Record<string, unknown>): FleetEvent {
  return { eventId: `e${seq}`, seq, ts: `2026-07-14T09:32:0${seq}.000Z`, missionId: 'm-test', type, data };
}

const spawnCaptain = ev(1, 'mission.started', { order: 'test order' });
const events: FleetEvent[] = [
  spawnCaptain,
  ev(2, 'node.spawned', { nodeId: 'captain', role: 'captain', driver: 'claude-code', taskId: 't1' }),
  ev(3, 'task.state', { taskId: 't1', assignee: 'captain', state: 'submitted' }),
  ev(4, 'message', { kind: 'ORDER', from: 'operator', to: 'captain', taskId: 't1', text: 'go' }),
  ev(5, 'task.state', { taskId: 't1', state: 'working' }),
  ev(6, 'node.spawned', { nodeId: 'crew-1', parentId: 'captain', role: 'scan', driver: 'claude-code', taskId: 't2' }),
  ev(7, 'task.state', { taskId: 't2', assignee: 'crew-1', state: 'working' }),
  ev(8, 'usage', { nodeId: 'crew-1', costUsd: 0.05 }),
];

const deliverEvent = ev(9, 'message', { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'done' });

describe('projectGraph', () => {
  const state = reduce(events);

  it('projects captain at depth 0, isCaptain true', () => {
    const { nodes } = projectGraph(state);
    const captain = nodes.find(n => n.id === 'captain');
    expect(captain).toBeDefined();
    expect(captain!.depth).toBe(0);
    expect(captain!.isCaptain).toBe(true);
    expect(captain!.state).toBe('working');
  });

  it('projects crew at depth 1, isCaptain false, with cost and driver', () => {
    const { nodes } = projectGraph(state);
    const crew = nodes.find(n => n.id === 'crew-1');
    expect(crew).toBeDefined();
    expect(crew!.depth).toBe(1);
    expect(crew!.isCaptain).toBe(false);
    expect(crew!.state).toBe('working');
    expect(crew!.driver).toBe('claude-code');
    expect(crew!.costUsd).toBeCloseTo(0.05);
  });

  it('creates the parent-child edge captain -> crew-1', () => {
    const { edges } = projectGraph(state);
    const edge = edges.find(e => e.source === 'captain' && e.target === 'crew-1');
    expect(edge).toBeDefined();
    expect(edge!.animating).toBe(false);
  });

  it('marks the traveled edge animating when a DELIVER message is the recent event', () => {
    const stateAfterDeliver = reduce([...events, deliverEvent]);
    const { edges } = projectGraph(stateAfterDeliver, deliverEvent);
    const edge = edges.find(e => e.source === 'captain' && e.target === 'crew-1');
    expect(edge).toBeDefined();
    expect(edge!.animating).toBe(true);
  });

  it('does not mark any edge animating when the recent event is not a message', () => {
    const { edges } = projectGraph(state, events[6]);
    expect(edges.every(e => !e.animating)).toBe(true);
  });
});

describe('layout', () => {
  it('places captain above crew (smaller y) in a top-down tree', () => {
    const state = reduce(events);
    const { nodes, edges } = projectGraph(state);
    const positioned = layout(nodes, edges);
    const captain = positioned.nodes.find(n => n.id === 'captain')!;
    const crew = positioned.nodes.find(n => n.id === 'crew-1')!;
    expect(captain.y).toBeLessThan(crew.y);
  });
});
