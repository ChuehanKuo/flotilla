import type { FleetEvent } from '@flota/kernel';

// ---- pure fold ---------------------------------------------------------
// The graph itself is always derived by folding events[0..cursor] through
// the kernel's reduce() (see App.tsx / graph.ts) — this module only tracks
// WHICH events are known and where the cursor sits, not fleet state itself,
// so it stays a thin, source-agnostic accumulator that both replay and live
// modes share.
export interface EventFold {
  events: FleetEvent[];
  cursor: number; // index of the newest known event; -1 = nothing yet
}

export const EMPTY_FOLD: EventFold = { events: [], cursor: -1 };

// A snapshot replaces the known event list wholesale and catches the cursor
// up to its end. That's correct for a live snapshot (the mission's current
// state — the graph should render "now" immediately). Replay mode's App
// resets its own scrub cursor to 0 after this so playback starts from the
// top instead; that's UI policy, not fold logic, so it lives in App.tsx.
export function applySnapshot(events: FleetEvent[]): EventFold {
  return { events, cursor: events.length - 1 };
}

// One streamed event appended to a fold; cursor always advances to the new
// end, so live mode's graph re-projects on every event as it arrives.
export function appendEvent(fold: EventFold, event: FleetEvent): EventFold {
  const events = [...fold.events, event];
  return { events, cursor: events.length - 1 };
}

// ---- event source abstraction ------------------------------------------
// Both replay and live sources speak the same message protocol so App
// consumes them identically regardless of mode. O3's Tauri source (backed
// by @tauri-apps/api's `listen` instead of a WebSocket) is a third
// implementation of this same FleetEventSource interface.
export type EventSourceMessage =
  | { type: 'snapshot'; missionId?: string; events: FleetEvent[] }
  | { type: 'event'; missionId?: string; event: FleetEvent }
  | { type: 'status'; status: 'connecting' | 'open' | 'closed' | 'error'; detail?: string };

export interface FleetEventSource {
  /** Start receiving messages; returns an unsubscribe function. */
  subscribe(onMessage: (msg: EventSourceMessage) => void): () => void;
}

// Runtime detection: true when the webview is hosted by the Tauri native
// shell (as opposed to a plain browser tab running `vite dev`). Checked at
// call time, not import time, since the injected globals land before React
// mounts but this still keeps the check self-contained for tests.
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

// REPLAY: an in-memory events array (O1's behavior), delivered as a single
// snapshot. No further messages — App's own play/scrub cursor drives the
// animation forward from there.
export function createReplaySource(events: FleetEvent[]): FleetEventSource {
  return {
    subscribe(onMessage) {
      onMessage({ type: 'snapshot', events });
      return () => {};
    },
  };
}

// LIVE: connects to the dev bridge (devBridge.mjs) — or, once O3 lands, a
// production equivalent speaking the same protocol — over WebSocket.
//
// Wire protocol (see devBridge.mjs for the server side):
//   { kind: 'snapshot', missionId, events }  -- sent on connect, and again
//                                                if the bridge switches to
//                                                a newer mission
//   { kind: 'event', missionId, event }      -- one newly-appended event
//   { kind: 'error', message }               -- e.g. no mission found yet
interface MinimalWebSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface LiveSourceOptions {
  // Injectable for tests / non-browser hosts: the browser's global
  // WebSocket by default, or e.g. the `ws` package's client in Node.
  WebSocketImpl?: new (url: string) => MinimalWebSocket;
  reconnectDelayMs?: number;
}

export function createLiveSource(url: string, opts: LiveSourceOptions = {}): FleetEventSource {
  const maybeWS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;
  if (!maybeWS) throw new Error('createLiveSource: no WebSocket implementation available (pass opts.WebSocketImpl)');
  // Rebind to a non-optional const: closures below capture this, and TS
  // doesn't propagate the truthiness narrowing above into nested functions.
  const WS: new (url: string) => MinimalWebSocket = maybeWS;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 1500;

  return {
    subscribe(onMessage) {
      let closedByCaller = false;
      let ws: MinimalWebSocket | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

      function connect() {
        onMessage({ type: 'status', status: 'connecting' });
        ws = new WS(url);
        ws.onopen = () => onMessage({ type: 'status', status: 'open' });
        ws.onmessage = ev => {
          let raw: { kind?: string; missionId?: string; events?: FleetEvent[]; event?: FleetEvent; message?: string };
          try {
            raw = JSON.parse(String(ev.data));
          } catch (e) {
            onMessage({ type: 'status', status: 'error', detail: `bad message from bridge: ${String(e)}` });
            return;
          }
          if (raw.kind === 'snapshot' && raw.events) onMessage({ type: 'snapshot', missionId: raw.missionId, events: raw.events });
          else if (raw.kind === 'event' && raw.event) onMessage({ type: 'event', missionId: raw.missionId, event: raw.event });
          else if (raw.kind === 'error') onMessage({ type: 'status', status: 'error', detail: raw.message });
        };
        ws.onerror = () => onMessage({ type: 'status', status: 'error' });
        ws.onclose = () => {
          onMessage({ type: 'status', status: 'closed' });
          if (!closedByCaller) reconnectTimer = setTimeout(connect, reconnectDelayMs);
        };
      }
      connect();

      return () => {
        closedByCaller = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        ws?.close();
      };
    },
  };
}

// TAURI: the native shell's production event source, backed by the Rust
// file-watcher in src-tauri/src/lib.rs (which replaces this dev bridge when
// the app is bundled). Wire protocol (see lib.rs):
//   invoke('get_snapshot') -> { missionId, events }   -- pulled on demand
//   listen('flota-snapshot', ...) -> { missionId, events } -- re-sent whenever
//                                                the watcher auto-follows a
//                                                newer mission, same shape as
//                                                the initial invoke result
//   listen('flota-event', ...)  -> { missionId, event }  -- one new event
//   listen('flota-status', ...) -> { status, detail? }
//
// Race handling: the Rust watcher starts on app launch and may `emit` events
// before this module's `listen()` calls resolve (both are async). So we
// attach the event listener FIRST and buffer anything it delivers before
// the snapshot arrives, then dedupe the buffer against the snapshot by
// `seq` once it lands (the snapshot is authoritative for every seq it
// covers), then flush whatever's left. Never drops or duplicates an event
// regardless of emit/listen ordering.
//
// Mission-switch handling: a `flota-snapshot` is authoritative each time it
// arrives (initial catch-up AND every later mission switch), so applying one
// always RESETS the seq ceiling to that snapshot's own max seq instead of
// extending the previous one. Without the reset, a switch to a newer mission
// (whose seqs restart at 1) would look like every new event is "already
// covered" by the old mission's much higher ceiling, and they'd be silently
// dropped — the exact bug this module's tests guard against.
export function createTauriSource(): FleetEventSource {
  return {
    subscribe(onMessage) {
      let cancelled = false;
      let unlistenEvent: (() => void) | undefined;
      let unlistenStatus: (() => void) | undefined;
      let unlistenSnapshot: (() => void) | undefined;

      onMessage({ type: 'status', status: 'connecting' });

      (async () => {
        const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
        if (cancelled) return;

        let gotSnapshot = false;
        let snapshotSeqCeiling = -1; // highest `seq` covered by the most recent snapshot
        const buffered: { missionId?: string; event: FleetEvent }[] = [];

        // Shared by the initial get_snapshot result and every later
        // flota-snapshot event: reset (not extend) the ceiling, forward a
        // fold-replacing 'snapshot' message to App, then flush anything that
        // arrived via 'flota-event' before this snapshot landed.
        function applySnapshot(missionId: string | undefined, events: FleetEvent[]) {
          gotSnapshot = true;
          snapshotSeqCeiling = -1;
          for (const e of events) if (e.seq > snapshotSeqCeiling) snapshotSeqCeiling = e.seq;
          onMessage({ type: 'snapshot', missionId, events });
          const pending = buffered.splice(0, buffered.length);
          for (const { missionId: bMissionId, event } of pending) {
            if (event.seq <= snapshotSeqCeiling) continue;
            onMessage({ type: 'event', missionId: bMissionId, event });
          }
        }

        unlistenEvent = await listen<{ missionId?: string; event: FleetEvent }>('flota-event', e => {
          const { missionId, event } = e.payload;
          if (!gotSnapshot) {
            buffered.push({ missionId, event });
            return;
          }
          if (event.seq <= snapshotSeqCeiling) return; // already included in the latest snapshot
          onMessage({ type: 'event', missionId, event });
        });
        if (cancelled) {
          unlistenEvent();
          return;
        }

        unlistenStatus = await listen<{ status: string; detail?: string }>('flota-status', e => {
          const { status, detail } = e.payload;
          if (status === 'connecting' || status === 'open' || status === 'closed' || status === 'error') {
            onMessage({ type: 'status', status, detail });
          }
        });
        if (cancelled) {
          unlistenStatus();
          return;
        }

        // Attached before the initial get_snapshot invoke resolves, in case
        // the watcher switches missions in that window.
        unlistenSnapshot = await listen<{ missionId?: string; events: FleetEvent[] }>('flota-snapshot', e => {
          applySnapshot(e.payload.missionId, e.payload.events);
        });
        if (cancelled) {
          unlistenSnapshot();
          return;
        }

        const snapshot = await invoke<{ missionId?: string; events: FleetEvent[] }>('get_snapshot');
        if (cancelled) return;
        // A 'flota-snapshot' may have already landed (and is at least as
        // fresh, since both read the same server-side mutex-guarded state)
        // — don't clobber it with this possibly-earlier invoke result.
        if (!gotSnapshot) applySnapshot(snapshot.missionId, snapshot.events);
        onMessage({ type: 'status', status: 'open' });
      })().catch(e => onMessage({ type: 'status', status: 'error', detail: String(e) }));

      return () => {
        cancelled = true;
        unlistenEvent?.();
        unlistenStatus?.();
        unlistenSnapshot?.();
      };
    },
  };
}
