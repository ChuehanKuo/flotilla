import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { reduce, type FleetEvent } from '@flota/kernel';
import {
  EMPTY_FOLD,
  applySnapshot,
  appendEvent,
  createReplaySource,
  createLiveSource,
  createTauriSource,
  type EventSourceMessage,
} from '../src/eventSource.js';

// createTauriSource talks to '@tauri-apps/api/event' and '.../core' via
// dynamic import, so we mock the module rather than a real Tauri host (there
// is no display/webview in CI). listen() calls are captured into `handlers`
// keyed by event name so the test can simulate the Rust side emitting.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
let mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return () => {
      delete handlers[name];
    };
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function ev(seq: number, type: FleetEvent['type'], data: Record<string, unknown>): FleetEvent {
  return { eventId: `e${seq}`, seq, ts: `2026-07-14T09:32:0${seq}.000Z`, missionId: 'm-test', type, data };
}

const SNAPSHOT_EVENTS: FleetEvent[] = [
  ev(1, 'mission.started', { order: 'test order' }),
  ev(2, 'node.spawned', { nodeId: 'captain', role: 'captain', driver: 'claude-code', taskId: 't1' }),
  ev(3, 'task.state', { taskId: 't1', assignee: 'captain', state: 'working' }),
];

const STREAMED_EVENTS: FleetEvent[] = [
  ev(4, 'node.spawned', { nodeId: 'crew-1', parentId: 'captain', role: 'scan', driver: 'claude-code', taskId: 't2' }),
  ev(5, 'task.state', { taskId: 't2', assignee: 'crew-1', state: 'working' }),
  ev(6, 'usage', { nodeId: 'crew-1', costUsd: 0.05 }),
];

describe('pure fold: applySnapshot + appendEvent', () => {
  it('starts empty', () => {
    expect(EMPTY_FOLD).toEqual({ events: [], cursor: -1 });
  });

  it('applySnapshot loads N events with cursor at the end', () => {
    const fold = applySnapshot(SNAPSHOT_EVENTS);
    expect(fold.events).toEqual(SNAPSHOT_EVENTS);
    expect(fold.cursor).toBe(SNAPSHOT_EVENTS.length - 1);
  });

  it('an initial snapshot of N events + M streamed events yields the correct final events/cursor', () => {
    let fold = applySnapshot(SNAPSHOT_EVENTS);
    for (const event of STREAMED_EVENTS) fold = appendEvent(fold, event);

    expect(fold.events).toEqual([...SNAPSHOT_EVENTS, ...STREAMED_EVENTS]);
    expect(fold.cursor).toBe(SNAPSHOT_EVENTS.length + STREAMED_EVENTS.length - 1);

    // and folding through the kernel's real reduce() over that exact slice
    // (events[0..cursor]) reconstructs the fleet state a live graph would show
    const state = reduce(fold.events.slice(0, fold.cursor + 1));
    expect(state.nodes['captain']).toBeDefined();
    expect(state.nodes['crew-1']).toBeDefined();
    expect(state.nodes['crew-1'].costUsd).toBeCloseTo(0.05);
  });

  it('appendEvent on an empty fold starts a one-event fold at cursor 0', () => {
    const fold = appendEvent(EMPTY_FOLD, SNAPSHOT_EVENTS[0]);
    expect(fold.events).toEqual([SNAPSHOT_EVENTS[0]]);
    expect(fold.cursor).toBe(0);
  });
});

describe('createReplaySource', () => {
  it('delivers the given events as a single snapshot message', () => {
    const messages: EventSourceMessage[] = [];
    const unsub = createReplaySource(SNAPSHOT_EVENTS).subscribe(m => messages.push(m));
    expect(messages).toEqual([{ type: 'snapshot', events: SNAPSHOT_EVENTS }]);
    unsub();
  });
});

describe('createLiveSource (real local WebSocket round-trip)', () => {
  let server: WebSocketServer | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('delivers a snapshot then streamed events, in order, over a real ws connection', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const ready = new Promise<number>(resolve => {
      server!.on('listening', () => {
        const addr = server!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    server.on('connection', client => {
      client.send(JSON.stringify({ kind: 'snapshot', missionId: 'm-test', events: SNAPSHOT_EVENTS }));
      for (const event of STREAMED_EVENTS) {
        client.send(JSON.stringify({ kind: 'event', missionId: 'm-test', event }));
      }
    });

    const port = await ready;
    const messages: EventSourceMessage[] = [];
    const received = new Promise<void>(resolve => {
      const unsub = createLiveSource(`ws://127.0.0.1:${port}`, { WebSocketImpl: NodeWebSocket as unknown as new (url: string) => any }).subscribe(
        msg => {
          messages.push(msg);
          // status(connecting) + status(open) + 1 snapshot + 3 events = 6
          if (messages.length >= 6) {
            unsub();
            resolve();
          }
        },
      );
    });

    await received;

    const snapshot = messages.find(m => m.type === 'snapshot');
    expect(snapshot).toEqual({ type: 'snapshot', missionId: 'm-test', events: SNAPSHOT_EVENTS });

    const streamed = messages.filter(m => m.type === 'event').map(m => (m as { event: FleetEvent }).event);
    expect(streamed).toEqual(STREAMED_EVENTS); // delivered in order
  });

  it('reports a status error message for a malformed frame instead of throwing', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const ready = new Promise<number>(resolve => {
      server!.on('listening', () => {
        const addr = server!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    server.on('connection', client => client.send('not json'));

    const port = await ready;
    const messages: EventSourceMessage[] = [];
    await new Promise<void>(resolve => {
      const unsub = createLiveSource(`ws://127.0.0.1:${port}`, { WebSocketImpl: NodeWebSocket as unknown as new (url: string) => any }).subscribe(
        msg => {
          messages.push(msg);
          if (msg.type === 'status' && msg.status === 'error') {
            unsub();
            resolve();
          }
        },
      );
    });

    expect(messages.some(m => m.type === 'status' && m.status === 'error')).toBe(true);
  });
});

describe('createTauriSource (mocked @tauri-apps/api): mission-switch snapshot handling', () => {
  afterEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    mockInvoke = vi.fn();
  });

  const missionAEvents: FleetEvent[] = [
    { eventId: 'a1', seq: 1, ts: '2026-07-14T09:00:00.000Z', missionId: 'm-A', type: 'mission.started', data: { order: 'mission A' } },
    {
      eventId: 'a2',
      seq: 2,
      ts: '2026-07-14T09:00:01.000Z',
      missionId: 'm-A',
      type: 'node.spawned',
      data: { nodeId: 'captain', role: 'captain', driver: 'claude-code', taskId: 't1' },
    },
  ];
  // A fresh mission's own EventLog starts its seqs over at 1 — this is what
  // the bug (unreset ceiling) silently dropped.
  const missionBSnapshot: FleetEvent[] = [
    { eventId: 'b1', seq: 1, ts: '2026-07-14T10:00:00.000Z', missionId: 'm-B', type: 'mission.started', data: { order: 'mission B' } },
  ];
  const missionBFollowup: FleetEvent = {
    eventId: 'b2',
    seq: 2,
    ts: '2026-07-14T10:00:01.000Z',
    missionId: 'm-B',
    type: 'node.spawned',
    data: { nodeId: 'captain', role: 'captain', driver: 'claude-code', taskId: 't1' },
  };

  it('a flota-snapshot mission switch resets the seq ceiling and forwards a fold-replacing snapshot, so the new mission is neither dropped nor merged with the old one', async () => {
    mockInvoke.mockResolvedValue({ missionId: 'm-A', events: missionAEvents });

    const messages: EventSourceMessage[] = [];
    const unsub = createTauriSource().subscribe(m => messages.push(m));

    await vi.waitFor(() => {
      if (!handlers['flota-snapshot']) throw new Error('flota-snapshot listener not attached yet');
    });
    await vi.waitFor(() => {
      if (!messages.some(m => m.type === 'snapshot')) throw new Error('initial snapshot not delivered yet');
    });

    const initialSnapshot = messages.find(m => m.type === 'snapshot');
    expect(initialSnapshot).toEqual({ type: 'snapshot', missionId: 'm-A', events: missionAEvents });

    // Simulate the Rust watcher auto-following a newer mission: with the fix,
    // it emits a fresh flota-snapshot here (the pre-fix lib.rs emitted only a
    // bare status, leaving the client's ceiling pinned to mission A's max seq).
    handlers['flota-snapshot']({ payload: { missionId: 'm-B', events: missionBSnapshot } });

    const snapshots = messages.filter(m => m.type === 'snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual({ type: 'snapshot', missionId: 'm-B', events: missionBSnapshot });

    // The regression this guards against: mission B's seq 2 must not be
    // swallowed as "already covered" by mission A's ceiling (also 2) — the
    // ceiling must have been RESET to mission B's own max (1) on the switch,
    // so this seq-2 follow-up for mission B is still fresh and forwarded.
    handlers['flota-event']({ payload: { missionId: 'm-B', event: missionBFollowup } });
    const forwardedEvents = messages.filter(m => m.type === 'event').map(m => (m as { event: FleetEvent }).event);
    expect(forwardedEvents).toEqual([missionBFollowup]);

    // Folding the delivered messages exactly the way App.tsx does (snapshot
    // replaces the fold wholesale; event appends) must yield mission B's
    // state alone — not mission A's events folded together with mission B's.
    let fold = EMPTY_FOLD;
    for (const msg of messages) {
      if (msg.type === 'snapshot') fold = applySnapshot(msg.events);
      else if (msg.type === 'event') fold = appendEvent(fold, msg.event);
    }
    expect(fold.events).toEqual([...missionBSnapshot, missionBFollowup]);
    const state = reduce(fold.events);
    expect(state.missionId).toBe('m-B');
    expect(state.nodes['captain']).toBeDefined();

    unsub();
  });
});
