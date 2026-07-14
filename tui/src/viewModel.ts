import type { EscalationView, FleetEvent, FleetState, TaskState } from '@flota/kernel';

export interface NodeRow {
  id: string;
  depth: number;
  role: string;
  driver: string;
  state: TaskState;
  costUsd: number;
  isCaptain: boolean;
}

export interface UiState {
  selectedNodeId?: string;
  mode: 'browse' | 'instruct' | 'answer';
  input: string;
  // Transient operator-facing status (e.g. why mission.instruct() just
  // declined), not a keystroke-driven UI mode — set/cleared by App.tsx
  // directly rather than through keymap.ts's Action/applyAction, since
  // nothing on the keyboard produces it.
  notice?: string;
}

function isRootParent(parentId: string | undefined): boolean {
  return parentId === undefined || parentId === 'operator';
}

// tree order: captain(s) first (in spawn order), then each node's children
// depth-first (also in spawn order, since s.nodes preserves insertion order).
export function fleetRows(s: FleetState): NodeRow[] {
  const ids = Object.keys(s.nodes);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const parentId = s.nodes[id].parentId;
    if (isRootParent(parentId)) { roots.push(id); continue; }
    const kids = childrenOf.get(parentId!);
    if (kids) kids.push(id); else childrenOf.set(parentId!, [id]);
  }

  const rows: NodeRow[] = [];
  const visit = (id: string, depth: number) => {
    const n = s.nodes[id];
    const task = s.tasks[n.taskId];
    rows.push({
      id,
      depth,
      role: n.role,
      driver: n.driver ?? '',
      state: task?.state ?? 'submitted',
      costUsd: n.costUsd,
      isCaptain: isRootParent(n.parentId),
    });
    for (const childId of childrenOf.get(id) ?? []) visit(childId, depth + 1);
  };
  for (const rootId of roots) visit(rootId, 0);
  return rows;
}

// human-readable lines for one node's own messages (as sender OR recipient),
// its usage events, and the task.state transitions of its own task. Other
// nodes' lines are excluded.
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

export function initialUi(): UiState {
  return { mode: 'browse', input: '', selectedNodeId: undefined };
}

// Which open escalation an answer-mode submit targets: the one raised by the
// currently selected node, falling back to the oldest open escalation if the
// selection doesn't match one (e.g. the operator selected a different node
// than the one that escalated). Pure so both App.tsx's submit handler and its
// pre-submit InputBar display can share one rule instead of drifting.
export function pickAnswerTarget(openEscalations: EscalationView[], selectedNodeId: string | undefined): EscalationView | undefined {
  return openEscalations.find(e => e.from === selectedNodeId) ?? openEscalations[0];
}
