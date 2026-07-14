import dagre from '@dagrejs/dagre';
import type { FleetEvent, FleetState } from '@flota/kernel';

export interface GraphNode {
  id: string;
  label: string;
  driver: string;
  state: string;
  costUsd: number;
  depth: number;
  isCaptain: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind?: string;
  animating: boolean;
}

// A message kind that rides an edge between a spawning node and its child
// (the only edges this graph draws — the fleet is a spawn tree).
const EDGE_MESSAGE_KINDS = new Set(['ORDER', 'REPORT', 'DELIVER', 'INSTRUCT']);

function isRootParent(parentId: string | undefined): boolean {
  return parentId === undefined || parentId === 'operator';
}

// project a FleetState (folded from events[0..cursor]) into graph nodes+edges;
// `recentMessage` (the event at the cursor, if a `message`) marks the edge it
// traveled as animating.
export function projectGraph(state: FleetState, recentMessage?: FleetEvent): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const ids = Object.keys(state.nodes);
  const depthCache = new Map<string, number>();

  function depthOf(id: string): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const n = state.nodes[id];
    const d = !n || isRootParent(n.parentId) ? 0 : depthOf(n.parentId!) + 1;
    depthCache.set(id, d);
    return d;
  }

  const nodes: GraphNode[] = ids.map(id => {
    const n = state.nodes[id];
    const task = state.tasks[n.taskId];
    return {
      id,
      label: id,
      driver: n.driver ?? '',
      state: task?.state ?? 'submitted',
      costUsd: n.costUsd,
      depth: depthOf(id),
      isCaptain: isRootParent(n.parentId),
    };
  });

  // Which parent->child edge (if any) the recentMessage traveled, expressed
  // as "parentId->childId" — messages can flow either direction (ORDER
  // parent->child, DELIVER/REPORT child->parent), so the edge id is derived
  // from the spawn relationship, not from message.from/to order.
  let animatingEdgeId: string | undefined;
  if (recentMessage?.type === 'message') {
    const d = recentMessage.data as { kind?: string; from?: string; to?: string };
    if (d.kind && EDGE_MESSAGE_KINDS.has(d.kind) && d.from && d.to) {
      const fromNode = state.nodes[d.from];
      const toNode = state.nodes[d.to];
      if (fromNode?.parentId === d.to) animatingEdgeId = `${d.to}->${d.from}`;
      else if (toNode?.parentId === d.from) animatingEdgeId = `${d.from}->${d.to}`;
    }
  }

  const edges: GraphEdge[] = [];
  for (const id of ids) {
    const n = state.nodes[id];
    if (isRootParent(n.parentId)) continue;
    const parentId = n.parentId!;
    if (!state.nodes[parentId]) continue; // parent not (yet) spawned in this fold
    const edgeId = `${parentId}->${id}`;
    edges.push({ id: edgeId, source: parentId, target: id, animating: edgeId === animatingEdgeId });
  }

  return { nodes, edges };
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 64;

// dagre top-down tree layout: captain(s) at rank 0, crew below, ranked by
// spawn depth via the same edges projectGraph produced.
export function layout(nodes: GraphNode[], edges: GraphEdge[]): { nodes: (GraphNode & { x: number; y: number })[]; edges: GraphEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const positioned = nodes.map(n => {
    const pos = g.node(n.id);
    return { ...n, x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 };
  });

  return { nodes: positioned, edges };
}

// human-readable lines for one node's own messages (sender or recipient),
// its usage events, and its task's state transitions — mirrors the TUI's
// nodeFeed (tui/src/viewModel.ts) so the observatory's inspector panel is a
// pure re-derivation of the event log, not separately-tracked state.
export function nodeFeed(events: FleetEvent[], nodeId: string): string[] {
  const lines: string[] = [];
  let taskId: string | undefined;
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'node.spawned':
        if (d.nodeId === nodeId) taskId = d.taskId as string;
        break;
      case 'message':
        if (d.from === nodeId || d.to === nodeId) {
          lines.push(`[${d.kind}] ${d.from} -> ${d.to}: ${d.text}`);
        }
        break;
      case 'usage':
        if (d.nodeId === nodeId) {
          lines.push(`[usage] $${(d.costUsd as number).toFixed(4)}`);
        }
        break;
      case 'task.state':
        if (taskId !== undefined && d.taskId === taskId) {
          lines.push(`[task] ${d.state}`);
        }
        break;
    }
  }
  return lines;
}
