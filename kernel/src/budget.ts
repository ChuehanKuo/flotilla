import type { MissionConfig } from './types.js';

export class BudgetExceededError extends Error {
  constructor(public spentUsd: number, public capUsd: number) {
    super(`budget exceeded: $${spentUsd.toFixed(2)} >= cap $${capUsd.toFixed(2)}`);
  }
}

export class BudgetTracker {
  private perNode = new Map<string, number>();
  private total = 0;

  constructor(private pricing: MissionConfig['pricing'], private missionCapUsd: number) {}

  addUsage(nodeId: string, model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const p = this.pricing[model];
    const cost = p ? (usage.inputTokens / 1e6) * p.inputPerMTok + (usage.outputTokens / 1e6) * p.outputPerMTok : 0;
    this.total += cost;
    this.perNode.set(nodeId, (this.perNode.get(nodeId) ?? 0) + cost);
    return cost;
  }

  get totalUsd(): number { return this.total; }
  nodeUsd(nodeId: string): number { return this.perNode.get(nodeId) ?? 0; }

  assertUnderCap(): void {
    if (this.total >= this.missionCapUsd) throw new BudgetExceededError(this.total, this.missionCapUsd);
  }
}
