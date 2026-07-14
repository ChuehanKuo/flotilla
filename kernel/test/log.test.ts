import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/log.js';

describe('EventLog', () => {
  it('assigns monotonic seq and timestamps', () => {
    const log = new EventLog('m-test');
    const a = log.append('mission.started', { order: 'x' });
    const b = log.append('node.spawned', { nodeId: 'captain' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.missionId).toBe('m-test');
    expect(new Date(a.ts).getTime()).toBeGreaterThan(0);
    expect(log.events).toHaveLength(2);
  });

  it('notifies subscribers and honors unsubscribe', () => {
    const log = new EventLog('m-test');
    const seen: string[] = [];
    const unsub = log.subscribe(e => seen.push(e.type));
    log.append('mission.started', {});
    unsub();
    log.append('mission.completed', {});
    expect(seen).toEqual(['mission.started']);
  });

  it('persists JSONL and round-trips via load', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flotilla-')), 'events.jsonl');
    const log = new EventLog('m-test', file);
    log.append('mission.started', { order: 'scan' });
    log.append('mission.completed', { result: 'ok' });
    const loaded = EventLog.load(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].data).toEqual({ order: 'scan' });
    expect(loaded[1].seq).toBe(2);
  });

  it('load skips unparseable lines instead of throwing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flotilla-')), 'events.jsonl');
    const log = new EventLog('m-test', file);
    log.append('mission.started', { order: 'scan' });
    log.append('mission.completed', { result: 'ok' });
    appendFileSync(file, '{"eventId":"trunc'); // simulated truncated final write
    const loaded = EventLog.load(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[1].type).toBe('mission.completed');
  });
});
