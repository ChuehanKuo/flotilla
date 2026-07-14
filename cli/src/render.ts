import pc from 'picocolors';
import type { FleetEvent } from '@flotilla/kernel';

const KIND_ICON: Record<string, string> = { ORDER: '→', REPORT: '←', DELIVER: '✓', ESCALATE: '⚠', ANSWER: '↩' };

function clock(ts: string): string { return pc.dim(ts.slice(11, 19)); }
function trunc(s: string): string { return s.length > 100 ? s.slice(0, 100) + '…' : s; }

export function formatEvent(e: FleetEvent): string | null {
  const d = e.data as any;
  switch (e.type) {
    case 'mission.started': return `${clock(e.ts)} ${pc.bold('▸')} mission ${e.missionId} started: ${d.order}`;
    case 'node.spawned': {
      const from = d.parentId ? ` ${pc.dim('← ' + d.parentId)}` : '';
      const runtime = d.provider ? `${d.provider}/${d.model}` : String(d.driver ?? 'unknown');
      return `${clock(e.ts)} ${pc.green('+')} ${pc.bold(d.nodeId)} spawned (${runtime})${from}`;
    }
    case 'message': {
      const icon = KIND_ICON[d.kind] ?? '·';
      const body = d.kind === 'DELIVER' ? pc.dim(`[${d.text.length} chars]`) : trunc(d.text);
      const color = d.kind === 'ESCALATE' ? pc.yellow : d.kind === 'DELIVER' ? pc.green : (x: string) => x;
      return `${clock(e.ts)} ${color(`${icon} ${d.kind.padEnd(8)}`)} ${d.from} → ${d.to} (${d.taskId}): ${body}`;
    }
    case 'usage': return `${clock(e.ts)} ${pc.dim(`$ usage    ${d.nodeId} +$${d.costUsd.toFixed(4)}`)}`;
    case 'watchdog': return `${clock(e.ts)} ${pc.red(`⚠ watchdog ${d.nodeId} silent`)}`;
    case 'mission.completed': return `${clock(e.ts)} ${pc.green('■ mission completed')}`;
    case 'mission.canceled': return `${clock(e.ts)} ${pc.red(`■ mission canceled: ${d.reason ?? ''}`)}`;
    case 'mission.failed': return `${clock(e.ts)} ${pc.red(`■ mission failed: ${d.reason ?? ''}`)}`;
    default: return null;
  }
}
