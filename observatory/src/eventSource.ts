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
