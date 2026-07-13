import { describe, it, expect } from 'vitest';
import { formatEvent } from '../src/render.js';
import type { FleetEvent } from '@flotilla/kernel';

const ev = (type: string, data: Record<string, unknown>): FleetEvent =>
  ({ eventId: 'e', seq: 1, ts: '2026-07-13T12:04:11.000Z', missionId: 'm-x', type: type as any, data });

describe('formatEvent', () => {
  it('renders spawn, message, usage, terminal events; hides task.state and tool.called', () => {
    expect(formatEvent(ev('node.spawned', { nodeId: 'captain', role: 'captain', provider: 'anthropic', model: 'claude-sonnet-4-5' })))
      .toContain('captain spawned (anthropic/claude-sonnet-4-5)');
    expect(formatEvent(ev('node.spawned', { nodeId: 'crew-2', driver: 'codex' })))
      .toContain('crew-2 spawned (codex)');
    expect(formatEvent(ev('message', { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'include non-ICU?' })))
      .toContain('ESCALATE');
    expect(formatEvent(ev('usage', { nodeId: 'captain', costUsd: 0.021 }))).toContain('+$0.0210');
    expect(formatEvent(ev('mission.completed', { result: 'x' }))).toContain('completed');
    expect(formatEvent(ev('task.state', { taskId: 't1', state: 'working' }))).toBeNull();
    expect(formatEvent(ev('tool.called', {}))).toBeNull();
  });

  it('truncates long message text at 100 chars and hides DELIVER bodies', () => {
    const long = 'y'.repeat(300);
    const line = formatEvent(ev('message', { kind: 'REPORT', from: 'a', to: 'b', taskId: 't', text: long }))!;
    expect(line.length).toBeLessThan(220);
    expect(line).toContain('…');
    const del = formatEvent(ev('message', { kind: 'DELIVER', from: 'a', to: 'b', taskId: 't', text: long }))!;
    expect(del).toContain('[300 chars]');
    expect(del).not.toContain('yyyy');
  });
});
