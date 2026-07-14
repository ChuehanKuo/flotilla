import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay } from '../src/replay.js';

describe('replay', () => {
  it('re-renders a persisted mission log in order', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-replay-')), 'events.jsonl');
    const events = [
      { eventId: 'a', seq: 1, ts: '2026-07-13T12:00:00.000Z', missionId: 'm-1', type: 'mission.started', data: { order: 'scan' } },
      { eventId: 'b', seq: 2, ts: '2026-07-13T12:00:01.000Z', missionId: 'm-1', type: 'task.state', data: { taskId: 't1', state: 'working' } },
      { eventId: 'c', seq: 3, ts: '2026-07-13T12:00:05.000Z', missionId: 'm-1', type: 'mission.completed', data: { result: 'ok' } },
    ];
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const lines: string[] = [];
    await replay(file, {}, l => lines.push(l));
    expect(lines).toHaveLength(2); // task.state hidden
    expect(lines[0]).toContain('mission m-1 started');
    expect(lines[1]).toContain('completed');
  });

  it('renders a marker line for shape-malformed records instead of crashing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-replay-')), 'events.jsonl');
    const events = [
      { eventId: 'a', seq: 1, ts: '2026-07-13T12:00:00.000Z', missionId: 'm-1', type: 'mission.started', data: { order: 'scan' } },
      // a message event missing data.text — formatEvent throws on d.text.length
      { eventId: 'b', seq: 2, ts: '2026-07-13T12:00:01.000Z', missionId: 'm-1', type: 'message', data: { kind: 'REPORT', from: 'a', to: 'b', taskId: 't' } },
    ];
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const lines: string[] = [];
    await replay(file, {}, l => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('malformed event (seq 2)');
  });
});
