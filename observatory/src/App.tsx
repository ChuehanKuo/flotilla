import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// WHY a deep import, not the '@flota/kernel' barrel: index.ts also re-exports
// EventLog/Mission/providers, which pull in node:fs, node:crypto, and express
// — fine for the Node-hosted TUI/CLI, but unbundlable for a browser build.
// reduce() is a pure function with zero Node dependencies, so importing it
// directly off reducer.ts keeps the browser bundle Node-free while still
// reusing the kernel's real fleet-state logic (no reimplementation).
import { reduce } from '@flota/kernel/src/reducer.js';
import type { FleetEvent } from '@flota/kernel';
import { projectGraph, layout, nodeFeed, type GraphNode } from './graph.js';

const STATE_COLOR: Record<string, string> = {
  submitted: '#6b7280',
  working: '#3b82f6',
  'input-required': '#d97706',
  completed: '#16a34a',
  failed: '#dc2626',
  canceled: '#6b7280',
  rejected: '#dc2626',
};

function FleetNodeView({ data, selected }: NodeProps) {
  const d = data as unknown as GraphNode;
  const color = STATE_COLOR[d.state] ?? '#6b7280';
  return (
    <div
      style={{
        border: `2px solid ${selected ? '#f8fafc' : color}`,
        background: '#111827',
        borderRadius: 10,
        padding: '8px 12px',
        minWidth: 160,
        color: '#e5e7eb',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        boxShadow: d.state === 'working' ? `0 0 14px ${color}` : 'none',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color, border: 'none' }} />
      <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        {d.isCaptain ? <span title="captain">⚑</span> : null}
        {d.label}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
        {d.driver || 'driver?'} · <span style={{ color }}>{d.state}</span>
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af' }}>${d.costUsd.toFixed(4)}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, border: 'none' }} />
    </div>
  );
}

const nodeTypes = { fleet: FleetNodeView };

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

export function App() {
  const [events, setEvents] = useState<FleetEvent[]>([]);
  const [cursor, setCursor] = useState(-1); // index of last folded event; -1 = nothing loaded yet
  const [playing, setPlaying] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [logUrl, setLogUrl] = useState('/mission.jsonl');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('log') ?? '/mission.jsonl';
    setLogUrl(url);
    loadEvents(url)
      .then(evs => {
        setEvents(evs);
        setCursor(evs.length > 0 ? 0 : -1);
      })
      .catch(e => setLoadError(String(e)));
  }, []);

  // REPLAY: advance the cursor on a timer while playing; each tick re-folds
  // reduce(events[0..cursor]) below, which is what makes the fleet animate.
  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCursor(c => Math.min(c + 1, events.length - 1)), PLAY_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [playing, cursor, events.length]);

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
      style: { stroke: e.animating ? '#38bdf8' : '#4b5563', strokeWidth: e.animating ? 3 : 1.5 },
    }));
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetState, recentEvent, selectedNodeId]);

  const feed = selectedNodeId ? nodeFeed(slice, selectedNodeId) : [];

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: '#0b0f14', color: '#e5e7eb' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onNodeClick={(_, n) => setSelectedNodeId(n.id)} fitView fitViewOptions={{ padding: 0.3 }}>
          <Background color="#1f2937" gap={24} />
          <Controls />
        </ReactFlow>

        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            right: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(17,24,39,0.85)',
            border: '1px solid #1f2937',
            borderRadius: 10,
            padding: '8px 12px',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: 13,
          }}
        >
          <strong>flota observatory</strong>
          <span style={{ color: '#9ca3af' }}>
            {fleetState.missionId || '—'} · {fleetState.status} · ${fleetState.totalCostUsd.toFixed(4)}
          </span>
          <span style={{ flex: 1 }} />
          {loadError ? <span style={{ color: '#dc2626' }}>{loadError}</span> : null}
          <button onClick={() => setCursor(0)} disabled={events.length === 0}>
            ⏮
          </button>
          <button onClick={() => setPlaying(p => !p)} disabled={events.length === 0}>
            {playing ? '⏸ pause' : '▶ play'}
          </button>
          <button onClick={() => setCursor(c => Math.min(c + 1, events.length - 1))} disabled={events.length === 0 || cursor >= events.length - 1}>
            step ⏭
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(events.length - 1, 0)}
            value={Math.max(cursor, 0)}
            onChange={e => {
              setPlaying(false);
              setCursor(Number(e.target.value));
            }}
            style={{ width: 220 }}
          />
          <span style={{ color: '#9ca3af', minWidth: 60 }}>
            {Math.max(cursor + 1, 0)}/{events.length}
          </span>
        </div>
      </div>

      <div
        style={{
          width: 340,
          borderLeft: '1px solid #1f2937',
          padding: 12,
          overflowY: 'auto',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
        }}
      >
        <div style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontWeight: 600, marginBottom: 8 }}>
          {selectedNodeId ? `inspector — ${selectedNodeId}` : 'select a node'}
        </div>
        {selectedNodeId ? (
          feed.length > 0 ? (
            feed.map((line, i) => (
              <div key={i} style={{ marginBottom: 6, color: '#d1d5db', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {line}
              </div>
            ))
          ) : (
            <div style={{ color: '#6b7280' }}>no events yet at this cursor position</div>
          )
        ) : (
          <div style={{ color: '#6b7280' }}>click a node to inspect its message/usage feed (log: {logUrl})</div>
        )}
      </div>
    </div>
  );
}
