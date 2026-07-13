import type { FleetEvent, TaskState } from './types.js';

export interface NodeView { id: string; parentId?: string; role: string; provider: string; model: string; taskId: string; costUsd: number; lastTs: string }
export interface TaskView { id: string; parentTaskId?: string; assignee: string; state: TaskState }
export interface EscalationView { taskId: string; from: string; text: string }
export interface FleetState {
  missionId: string; order: string;
  status: 'running' | 'completed' | 'canceled' | 'failed';
  nodes: Record<string, NodeView>;
  tasks: Record<string, TaskView>;
  openEscalations: EscalationView[];
  totalCostUsd: number;
  result?: string;
}

export function reduce(events: FleetEvent[]): FleetState {
  const s: FleetState = {
    missionId: events[0]?.missionId ?? '', order: '', status: 'running',
    nodes: {}, tasks: {}, openEscalations: [], totalCostUsd: 0,
  };
  for (const e of events) {
    const d = e.data as any;
    switch (e.type) {
      case 'mission.started': s.order = d.order; break;
      case 'node.spawned':
        s.nodes[d.nodeId] = { id: d.nodeId, parentId: d.parentId, role: d.role, provider: d.provider, model: d.model, taskId: d.taskId, costUsd: 0, lastTs: e.ts };
        break;
      case 'task.state': {
        const prev = s.tasks[d.taskId];
        s.tasks[d.taskId] = { id: d.taskId, parentTaskId: d.parentTaskId ?? prev?.parentTaskId, assignee: d.assignee ?? prev?.assignee ?? '', state: d.state };
        if (d.state !== 'input-required') s.openEscalations = s.openEscalations.filter(x => x.taskId !== d.taskId);
        break;
      }
      case 'message':
        if (s.nodes[d.from]) s.nodes[d.from].lastTs = e.ts;
        if (d.kind === 'ESCALATE') s.openEscalations.push({ taskId: d.taskId, from: d.from, text: d.text });
        break;
      case 'usage': {
        const n = s.nodes[d.nodeId];
        if (n) { n.costUsd += d.costUsd; n.lastTs = e.ts; }
        s.totalCostUsd += d.costUsd;
        break;
      }
      case 'mission.completed': s.status = 'completed'; s.result = d.result; break;
      case 'mission.canceled': s.status = 'canceled'; break;
      case 'mission.failed': s.status = 'failed'; break;
    }
  }
  return s;
}

export function nodeState(s: FleetState, nodeId: string): TaskState {
  return s.tasks[s.nodes[nodeId].taskId].state;
}
