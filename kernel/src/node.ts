import type { ModelMessage, ToolSet } from 'ai';
import type { EventLog } from './log.js';
import type { FleetMessage } from './types.js';
import type { TurnDriver, TurnOutput } from './driver.js';

export interface NodeSpec {
  id: string; parentId: string; role: string; charter: string;
  taskId: string; depth: number; captain: boolean;
}

export interface NodeDeps {
  driver: TurnDriver;
  tools: ToolSet;
  log: EventLog;
  maxStepsPerTurn: number;
  beforeModelCall(): void;
  onUsage(nodeId: string, usage: { inputTokens: number; outputTokens: number }, billing: 'api' | 'subscription'): void;
  onTurnEnd(nodeId: string, finalText: string): void;
  onModelFailure(nodeId: string, error: string): void;
  abortSignal: AbortSignal;
}

export class AgentNode {
  private transcript: ModelMessage[] = [];
  private pending: FleetMessage[] = [];
  private running = false;

  constructor(readonly spec: NodeSpec, private deps: NodeDeps) {}

  get busy(): boolean { return this.running; }

  get hasPending(): boolean { return this.pending.length > 0; }

  enqueue(msg: FleetMessage): void {
    this.pending.push(msg);
    // WHY the catch fence: kernel hooks run inside this floating promise; a
    // throwing hook must surface as a node failure, not an unhandledRejection.
    if (!this.running) {
      void this.runLoop().catch(err => {
        try { this.deps.onModelFailure(this.spec.id, `node loop crashed: ${String(err)}`); } catch { /* never rethrow into the void */ }
      });
    }
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        const text = batch.map(m => `[${m.kind} from ${m.from} · task ${m.taskId}] ${m.text}`).join('\n\n');
        this.transcript.push({ role: 'user', content: text });
        const result = await this.callDriverWithRetry(text);
        if (!result) return; // failure already reported
        this.transcript.push(...result.responseMessages);
        this.deps.onUsage(this.spec.id, result.usage, result.billing);
        this.deps.onTurnEnd(this.spec.id, result.text);
      }
    } finally {
      this.running = false;
    }
  }

  private async callDriverWithRetry(newText: string): Promise<TurnOutput | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.deps.beforeModelCall();
        return await this.deps.driver.turn({
          system: this.spec.charter,
          newText,
          transcript: this.transcript,
          tools: this.deps.tools,
          maxSteps: this.deps.maxStepsPerTurn,
          abortSignal: this.deps.abortSignal,
        });
      } catch (err) {
        if (this.deps.abortSignal.aborted) return null;
        if (attempt === 1) {
          this.deps.onModelFailure(this.spec.id, String(err));
          return null;
        }
      }
    }
    return null;
  }
}
