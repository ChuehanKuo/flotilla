import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './theme.css';
// WHY a deep import, not the '@flota/kernel' barrel: index.ts also re-exports
// EventLog/Mission/providers, which pull in node:fs, node:crypto, and express
// — fine for the Node-hosted TUI/CLI, but unbundlable for a browser build.
// reduce() is a pure function with zero Node dependencies, so importing it
// directly off reducer.ts keeps the browser bundle Node-free while still
// reusing the kernel's real fleet-state logic (no reimplementation).
import { reduce } from '@flota/kernel/src/reducer.js';
import type { FleetEvent } from '@flota/kernel';
import { projectGraph, layout, nodeFeed, type GraphNode } from './graph.js';
import {
  applySnapshot,
  appendEvent,
  createReplaySource,
  createLiveSource,
  createTauriSource,
  isTauriRuntime,
  EMPTY_FOLD,
  type EventFold,
  type EventSourceMessage,
} from './eventSource.js';

// State colors double as the semantic legend across the node, the edges it
// touches, and the inspector feed tags — one palette, three places, so the
// meaning of a color never has to be relearned per-panel.
const STATE_COLOR: Record<string, string> = {
  submitted: 'var(--state-submitted)',
  working: 'var(--state-working)',
  'input-required': 'var(--state-input-required)',
  completed: 'var(--state-completed)',
  failed: 'var(--state-failed)',
  canceled: 'var(--state-canceled)',
  rejected: 'var(--state-rejected)',
};

function FleetNodeView({ data, selected }: NodeProps) {
  const d = data as unknown as GraphNode;
  const color = STATE_COLOR[d.state] ?? STATE_COLOR.submitted;
  const classes = [
    'fleet-node',
    d.isCaptain ? 'fleet-node--captain' : '',
    d.state === 'input-required' ? 'fleet-node--input-required' : '',
    selected ? 'fleet-node--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} style={{ '--node-color': color } as CSSProperties}>
      {d.state === 'working' ? <div className="fleet-node__pulse" /> : null}
      <Handle type="target" position={Position.Top} style={{ background: color, border: 'none' }} />
      <div className="fleet-node__title">
        {d.isCaptain ? (
          <span className="fleet-node__anchor" title="captain — reports to the operator">
            ⚓
          </span>
        ) : null}
        {d.label}
      </div>
      <div className="fleet-node__meta">
        <span className="fleet-node__state-dot" />
        {d.state}
        <span className="fleet-node__driver-badge">{d.driver || 'driver?'}</span>
      </div>
      <div className="fleet-node__cost">${d.costUsd.toFixed(4)}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { fleet: FleetNodeView };

// Inspector feed lines are plain strings from graph.ts's nodeFeed (kept pure
// and untagged there); the "[TAG] ..." prefix is parsed here purely for
// presentation so the color legend covers the log too without teaching
// graph.ts anything about rendering.
const FEED_TAG_COLOR: Record<string, string> = {
  ORDER: 'var(--state-working)',
  INSTRUCT: 'var(--captain-gold)',
  REPORT: 'var(--state-working)',
  DELIVER: 'var(--state-completed)',
  ESCALATE: 'var(--state-input-required)',
  usage: 'var(--captain-gold)',
  task: 'var(--text-dim)',
};

function feedLineParts(line: string): { tag?: string; color: string; rest: string } {
  const m = /^\[(\w+)\]\s?(.*)$/.exec(line);
  if (!m) return { color: 'var(--text-dim)', rest: line };
  const tag = m[1];
  return { tag, color: FEED_TAG_COLOR[tag] ?? 'var(--text-dim)', rest: m[2] };
}

async function loadEvents(url: string): Promise<FleetEvent[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  const text = await res.text();
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as FleetEvent);
}

const PLAY_INTERVAL_MS = 220;
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:4317';

// Mode resolution: running inside the Tauri native shell always wins (it's
// the shipped app, not a dev preview, and has no other way to get events).
// Otherwise ?live=1 (or any truthy value other than '0'/'false') switches
// the browser dev preview into live mode; ?bridge=ws://... overrides the
// dev bridge URL. All read once at mount — this app doesn't support
// switching modes without a reload.
function readModeFromUrl(): { mode: 'replay' | 'live' | 'tauri'; logUrl: string; bridgeUrl: string } {
  const params = new URLSearchParams(window.location.search);
  const logUrl = params.get('log') ?? '/mission.jsonl';
  const bridgeUrl = params.get('bridge') ?? DEFAULT_BRIDGE_URL;
  if (isTauriRuntime()) return { mode: 'tauri', logUrl, bridgeUrl };
  const live = params.get('live');
  const mode = live && live !== '0' && live !== 'false' ? 'live' : 'replay';
  return { mode, logUrl, bridgeUrl };
}

export function App() {
  const [{ mode, logUrl, bridgeUrl }] = useState(readModeFromUrl);
  const [fold, setFold] = useState<EventFold>(EMPTY_FOLD);
  const [replayCursor, setReplayCursor] = useState(-1); // replay mode's own scrub position
  const [playing, setPlaying] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [missionLabel, setMissionLabel] = useState<string | undefined>();

  const handleSourceMessage = useCallback(
    (msg: EventSourceMessage) => {
      if (msg.type === 'snapshot') {
        setFold(applySnapshot(msg.events));
        if (mode === 'replay') setReplayCursor(msg.events.length > 0 ? 0 : -1);
        if (msg.missionId) setMissionLabel(msg.missionId);
      } else if (msg.type === 'event') {
        setFold(prev => appendEvent(prev, msg.event));
        if (msg.missionId) setMissionLabel(msg.missionId);
      } else {
        setConnectionStatus(msg.status);
        if (msg.status === 'error' && msg.detail) setLoadError(msg.detail);
      }
    },
    [mode],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    if (mode === 'tauri') {
      unsubscribe = createTauriSource().subscribe(handleSourceMessage);
    } else if (mode === 'live') {
      unsubscribe = createLiveSource(bridgeUrl).subscribe(handleSourceMessage);
    } else {
      setConnectionStatus('connecting');
      loadEvents(logUrl)
        .then(evs => {
          if (cancelled) return;
          setConnectionStatus('open');
          unsubscribe = createReplaySource(evs).subscribe(handleSourceMessage);
        })
        .catch(e => setLoadError(String(e)));
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [mode, logUrl, bridgeUrl, handleSourceMessage]);

  const events = fold.events;
  // live and tauri modes always track the fold's own cursor (auto-follow
  // "now"); replay mode drives its own independent scrub/play cursor.
  const cursor = mode === 'live' || mode === 'tauri' ? fold.cursor : replayCursor;

  // REPLAY: advance the cursor on a timer while playing; each tick re-folds
  // reduce(events[0..cursor]) below, which is what makes the fleet animate.
  useEffect(() => {
    if (mode !== 'replay' || !playing) return;
    if (replayCursor >= events.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setReplayCursor(c => Math.min(c + 1, events.length - 1)), PLAY_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [mode, playing, replayCursor, events.length]);

  const slice = useMemo(() => events.slice(0, cursor + 1), [events, cursor]);
  const fleetState = useMemo(() => reduce(slice), [slice]);
  const recentEvent = cursor >= 0 ? events[cursor] : undefined;

  const { nodes: flowNodes, edges: flowEdges } = useMemo(() => {
    const projected = projectGraph(fleetState, recentEvent);
    const positioned = layout(projected.nodes, projected.edges);
    const nodes: Node[] = positioned.nodes.map(n => ({
      id: n.id,
      type: 'fleet',
      position: { x: n.x, y: n.y },
      data: n as unknown as Record<string, unknown>,
      selected: n.id === selectedNodeId,
    }));
    const edges: Edge[] = positioned.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.animating,
      style: {
        stroke: e.animating ? 'var(--state-working)' : 'var(--line-bright)',
        strokeWidth: e.animating ? 2.5 : 1.5,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: e.animating ? 'var(--state-working)' : 'var(--line-bright)', width: 16, height: 16 },
    }));
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetState, recentEvent, selectedNodeId]);

  const feed = selectedNodeId ? nodeFeed(slice, selectedNodeId) : [];
  const selectedNode = selectedNodeId ? (flowNodes.find(n => n.id === selectedNodeId)?.data as GraphNode | undefined) : undefined;
  const nodeCount = Object.keys(fleetState.nodes).length;
  const escalations = fleetState.openEscalations;

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div className="flota-canvas" style={{ flex: 1, position: 'relative' }}>
        <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onNodeClick={(_, n) => setSelectedNodeId(n.id)} fitView fitViewOptions={{ padding: 0.3 }}>
          <Background color="var(--line)" gap={26} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        <div className="flota-header">
          <div className="flota-header__bar">
            <span className="flota-header__brand">
              <span className="anchor">⚓</span>
              flota observatory
            </span>
            <div className="flota-header__divider" />
            <span className="flota-header__mission">
              mission <strong>{fleetState.missionId || missionLabel || '—'}</strong>
            </span>
            <span
              className="status-pill"
              style={{ color: STATE_COLOR[fleetState.status === 'running' ? 'working' : fleetState.status] ?? STATE_COLOR.submitted }}
            >
              {fleetState.status}
            </span>
            {mode === 'live' || mode === 'tauri' ? (
              <span
                className="status-pill"
                title={`connection: ${connectionStatus}`}
                style={{
                  color:
                    connectionStatus === 'open'
                      ? 'var(--state-completed)'
                      : connectionStatus === 'error'
                        ? 'var(--state-failed)'
                        : 'var(--state-input-required)',
                }}
              >
                ● {connectionStatus === 'open' ? (mode === 'tauri' ? 'native' : 'live') : connectionStatus}
              </span>
            ) : null}
            <span className="flota-header__spacer" />
            {loadError ? <span className="flota-header__error">{loadError}</span> : null}
            <span className="flota-header__stat">
              <strong>{nodeCount}</strong> node{nodeCount === 1 ? '' : 's'}
            </span>
            <span className="flota-header__stat">
              <strong>${fleetState.totalCostUsd.toFixed(4)}</strong>
            </span>
            {mode === 'replay' ? (
              <>
                <button className="flota-transport-btn" onClick={() => setReplayCursor(0)} disabled={events.length === 0}>
                  ⏮
                </button>
                <button className="flota-transport-btn" onClick={() => setPlaying(p => !p)} disabled={events.length === 0}>
                  {playing ? '⏸ pause' : '▶ play'}
                </button>
                <button
                  className="flota-transport-btn"
                  onClick={() => setReplayCursor(c => Math.min(c + 1, events.length - 1))}
                  disabled={events.length === 0 || replayCursor >= events.length - 1}
                >
                  step ⏭
                </button>
                <input
                  className="flota-scrub"
                  type="range"
                  min={0}
                  max={Math.max(events.length - 1, 0)}
                  value={Math.max(replayCursor, 0)}
                  onChange={e => {
                    setPlaying(false);
                    setReplayCursor(Number(e.target.value));
                  }}
                  style={{ width: 200 }}
                />
                <span className="flota-header__stat">
                  {Math.max(replayCursor + 1, 0)}/{events.length}
                </span>
              </>
            ) : (
              <span className="flota-header__stat">{events.length} events</span>
            )}
          </div>

          {escalations.length > 0 ? (
            <div className="escalation-banner" onClick={() => setSelectedNodeId(escalations[0].from)} title="click to inspect the escalating node">
              <span className="escalation-banner__count">
                ⚠ {escalations.length} escalation{escalations.length === 1 ? '' : 's'} waiting on you
              </span>
              <span style={{ color: 'var(--text-dim)' }}>
                {escalations
                  .slice(0, 2)
                  .map(esc => `${esc.from}: “${esc.text}”`)
                  .join('  ·  ')}
                {escalations.length > 2 ? '  ·  …' : ''}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="inspector">
        <div className="inspector__header">
          <div className="inspector__title">{selectedNodeId ? 'inspector' : 'fleet'}</div>
          {selectedNode ? (
            <>
              <div className="inspector__node-name">
                {selectedNode.isCaptain ? '⚓ ' : ''}
                {selectedNode.label}
              </div>
              <div className="inspector__node-meta">
                <span className="status-pill" style={{ color: STATE_COLOR[selectedNode.state] ?? STATE_COLOR.submitted, fontSize: 9 }}>
                  {selectedNode.state}
                </span>
                <span className="fleet-node__driver-badge">{selectedNode.driver || 'driver?'}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                  ${selectedNode.costUsd.toFixed(4)}
                </span>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 2 }}>select a node to inspect its feed</div>
          )}
        </div>
        <div className="inspector__feed">
          {selectedNodeId ? (
            feed.length > 0 ? (
              feed.map((line, i) => {
                const { tag, color, rest } = feedLineParts(line);
                return (
                  <div key={i} className="inspector__line">
                    {tag ? (
                      <span className="inspector__tag" style={{ color, border: `1px solid ${color}` }}>
                        {tag}
                      </span>
                    ) : null}
                    <span>{rest}</span>
                  </div>
                );
              })
            ) : (
              <div className="inspector__empty">no events yet at this cursor position</div>
            )
          ) : (
            <div className="inspector__empty">
              click a node in the fleet to see its message/usage feed.
              <br />
              <br />
              source: {mode === 'tauri' ? 'native — Rust file-watch' : mode === 'live' ? `live — ${bridgeUrl}` : `replay — ${logUrl}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
