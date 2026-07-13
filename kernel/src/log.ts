import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { EventType, FleetEvent } from './types.js';

export class EventLog {
  readonly events: FleetEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: FleetEvent) => void>();

  constructor(private missionId: string, private filePath?: string) {}

  append(type: EventType, data: Record<string, unknown>): FleetEvent {
    const event: FleetEvent = {
      eventId: randomUUID(),
      seq: ++this.seq,
      ts: new Date().toISOString(),
      missionId: this.missionId,
      type,
      data,
    };
    this.events.push(event);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(event) + '\n');
    for (const fn of this.listeners) fn(event);
    return event;
  }

  subscribe(fn: (e: FleetEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  static load(filePath: string): FleetEvent[] {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as FleetEvent);
  }
}
