import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventLog } from './log.js';
import { reduce, type FleetState } from './reducer.js';
import { BudgetTracker, BudgetExceededError } from './budget.js';
import { AgentNode } from './node.js';
import { makeFileTools } from './tools/files.js';
import { makeCoordinationTools, type KernelApi } from './tools/coordination.js';
import type { DriverFactory } from './providers.js';
import type { DriverKind, FleetMessage, MissionConfig, NodeRef, Provider, TaskState } from './types.js';

export interface MissionDeps { driverFactory: DriverFactory; missionsDir?: string }
export interface MissionResult { status: 'completed' | 'canceled' | 'failed'; result?: string; reason?: string; totalCostUsd: number }

const CAPTAIN_CHARTER = `You are the mission captain of an agent fleet. The operator's order follows as your task.
Decompose it into parallel subtasks and spawn crew with the delegate tool (each gets a
focused charter and task). Crew results arrive later as DELIVER messages; answer crew
ESCALATE questions with the answer tool when you can, escalate to the operator only when
you genuinely cannot decide. When all crew work is in, synthesize and call deliver with
the complete final result. Never do large subtasks yourself — delegate.`;

const CREW_SUFFIX = `
---
You are one crew agent in a fleet. Work only your assigned task. Use report for interim
progress, escalate when you need a decision, and end by calling deliver with your complete
result. You have file tools scoped to a shared mission workspace.`;

export class Mission {
  readonly id: string;
  readonly log: EventLog;
  private nodes = new Map<string, AgentNode>();
  private counter = 0;
  private budget: BudgetTracker;
  private workspaceDir: string;
  private abort = new AbortController();
  private escalationCb?: (e: { taskId: string; from: string; text: string }) => void;
  private resolveResult!: (r: MissionResult) => void;
  private done = false;
  private timers: { watchdog?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {};
  private watchdogFired = new Set<string>();
  private turnCounts = new Map<string, number>();

  constructor(private order: string, private config: MissionConfig, private deps: MissionDeps) {
    this.id = `m-${Date.now().toString(36)}`;
    if (deps.missionsDir) {
      const dir = join(deps.missionsDir, this.id);
      // WHY resolve(): a relative missionsDir (e.g. supplied as a bare CLI arg)
      // left workspaceDir relative, which broke two things — resolveSafe()
      // (tools/files.ts) compares an absolute resolve(workspaceDir, path)
      // against workspaceDir itself, so every file op was rejected as
      // "path escapes workspace"; and codex's `--cd` needs an absolute path,
      // which was the live P6 workspace-path fault.
      this.workspaceDir = resolve(join(dir, 'workspace'));
      mkdirSync(this.workspaceDir, { recursive: true });
      this.log = new EventLog(this.id, join(dir, 'events.jsonl'));
    } else {
      // mkdtempSync already returns absolute; resolve() here is a no-op kept
      // for uniformity so workspaceDir is provably absolute either branch.
      this.workspaceDir = resolve(mkdtempSync(join(tmpdir(), 'flotilla-ws-')));
      this.log = new EventLog(this.id);
    }
    this.budget = new BudgetTracker(config.pricing, config.budgetUsd);
  }

  state(): FleetState { return reduce(this.log.events); }
  onOperatorEscalation(cb: (e: { taskId: string; from: string; text: string }) => void) { this.escalationCb = cb; }

  answerEscalation(taskId: string, text: string): void {
    this.route({ kind: 'ANSWER', from: 'operator', to: '', taskId, text });
  }

  cancel(reason: string): void { this.finish({ status: 'canceled', reason, totalCostUsd: this.budget.totalUsd }, 'mission.canceled', { reason }); }

  start(): Promise<MissionResult> {
    const promise = new Promise<MissionResult>(res => { this.resolveResult = res; });
    this.log.append('mission.started', { order: this.order, config: { budgetUsd: this.config.budgetUsd, maxDepth: this.config.maxDepth } });
    const captainId = this.spawn('operator', 1, true, 'captain', CAPTAIN_CHARTER, this.config.models.captain);
    this.route({ kind: 'ORDER', from: 'operator', to: captainId, taskId: this.nodes.get(captainId)!.spec.taskId, text: this.order });
    this.timers.timeout = setTimeout(() => this.cancel('mission timeout'), this.config.missionTimeoutMs);
    this.timers.timeout.unref?.();
    this.timers.watchdog = setInterval(() => this.checkWatchdog(), 30_000);
    this.timers.watchdog.unref?.();
    return promise;
  }

  private finish(result: MissionResult, eventType: 'mission.completed' | 'mission.canceled' | 'mission.failed', data: Record<string, unknown>): void {
    if (this.done) return;
    this.done = true;
    if (this.timers.watchdog) clearInterval(this.timers.watchdog);
    if (this.timers.timeout) clearTimeout(this.timers.timeout);
    this.abort.abort();
    this.log.append(eventType, data);
    this.resolveResult(result);
  }

  private taskStateOf(taskId: string): TaskState { return this.state().tasks[taskId]?.state; }

  private spawn(parentId: string, depth: number, captain: boolean, role: string, charter: string, ref: NodeRef): string {
    this.counter++;
    const nodeId = captain ? 'captain' : `${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.counter}`;
    const taskId = `t${this.counter}`;
    const parentTaskId = parentId === 'operator' ? undefined : this.nodes.get(parentId)?.spec.taskId;
    this.log.append('node.spawned', { nodeId, parentId: parentId === 'operator' ? undefined : parentId, role, driver: ref.driver, provider: ref.provider, model: ref.model, taskId });
    this.log.append('task.state', { taskId, parentTaskId, assignee: nodeId, state: 'submitted' });

    const api: KernelApi = {
      delegate: (from, args) => this.delegate(from, args),
      emitMessage: (msg) => this.route(msg),
    };
    const tools = {
      ...makeCoordinationTools({ nodeId, taskId, parentId, captain }, api),
      ...(captain ? {} : makeFileTools(this.workspaceDir)),
    };
    const node = new AgentNode(
      { id: nodeId, parentId, role, charter: captain ? charter : charter + CREW_SUFFIX, taskId, depth, captain },
      {
        driver: this.deps.driverFactory(ref, { workspaceDir: this.workspaceDir }),
        tools,
        log: this.log,
        maxStepsPerTurn: this.config.maxStepsPerTurn,
        // WHY a per-node counter here rather than in AgentNode: maxTurnsPerNode is
        // a kernel-level rail (config), and node.ts's retry loop calls this once
        // per attempt — a spent cap must fail every retry, not just the first, so
        // the node's existing retry-then-escalate machinery surfaces it cleanly.
        // This also means pre-cap transient retries (a failed attempt that gets
        // retried before the cap is hit) consume attempts against the same
        // counter — conservative by design, not a bug: a node that keeps
        // failing and retrying burns down its turn budget rather than retrying
        // forever underneath the cap.
        beforeModelCall: () => {
          const n = (this.turnCounts.get(nodeId) ?? 0) + 1;
          this.turnCounts.set(nodeId, n);
          if (n > this.config.maxTurnsPerNode) throw new Error(`TurnCapError: ${nodeId} exceeded ${this.config.maxTurnsPerNode} turns`);
          this.budget.assertUnderCap();
        },
        onUsage: (id, usage, billing) => {
          const modelId = ref.model ?? (ref.provider ? this.config.models.apiDefaults[ref.provider] : 'unknown');
          const costUsd = billing === 'api' ? this.budget.addUsage(id, modelId, usage) : 0;
          this.log.append('usage', { nodeId: id, ...usage, costUsd, billing });
        },
        onTurnEnd: (id, finalText) => this.handleTurnEnd(id, finalText),
        onModelFailure: (id, error) => this.handleModelFailure(id, error),
        abortSignal: this.abort.signal,
      },
    );
    this.nodes.set(nodeId, node);
    return nodeId;
  }

  private delegate(fromNodeId: string, args: { role: string; charter: string; task: string; driver?: DriverKind; provider?: Provider; model?: string }): string {
    const outcome = this.tryDelegate(fromNodeId, args);
    this.log.append('tool.called', { nodeId: fromNodeId, tool: 'delegate', role: args.role, outcome });
    return outcome;
  }

  private tryDelegate(fromNodeId: string, args: { role: string; charter: string; task: string; driver?: DriverKind; provider?: Provider; model?: string }): string {
    const parent = this.nodes.get(fromNodeId)!;
    const childDepth = parent.spec.depth + 1;
    if (childDepth > this.config.maxDepth) return 'refused: depth cap reached';
    const children = [...this.nodes.values()].filter(n => n.spec.parentId === fromNodeId);
    if (children.length >= this.config.maxChildren) return 'refused: max children reached';
    const live = [...this.nodes.values()].filter(n => !['completed', 'failed', 'canceled'].includes(this.taskStateOf(n.spec.taskId)));
    if (live.length >= this.config.maxConcurrentNodes) return 'refused: max concurrent nodes reached';

    const fallback = this.config.models.crew[children.length % this.config.models.crew.length];
    const ref: NodeRef = (args.driver || args.provider)
      ? (() => {
          const driver = args.driver ?? 'api';
          if (driver !== 'api') return { driver, provider: args.provider, model: args.model };
          const provider = args.provider ?? 'anthropic';
          return { driver, provider, model: args.model ?? this.config.models.apiDefaults[provider] };
        })()
      : fallback;
    const childId = this.spawn(fromNodeId, childDepth, false, args.role, args.charter, ref);
    const childTaskId = this.nodes.get(childId)!.spec.taskId;
    this.route({ kind: 'ORDER', from: fromNodeId, to: childId, taskId: childTaskId, text: args.task });
    return `spawned ${childId} (task ${childTaskId})`;
  }

  private route(msg: FleetMessage): void {
    if (this.done) return;
    const assignee = this.state().tasks[msg.taskId]?.assignee;
    const resolved = { ...msg, to: msg.kind === 'ANSWER' ? assignee ?? msg.to : msg.to };
    this.log.append('message', { ...resolved });
    switch (resolved.kind) {
      case 'ORDER':
        this.log.append('task.state', { taskId: resolved.taskId, state: 'working' });
        this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
      case 'ESCALATE':
        this.log.append('task.state', { taskId: resolved.taskId, state: 'input-required' });
        if (resolved.to === 'operator') {
          try { this.escalationCb?.({ taskId: resolved.taskId, from: resolved.from, text: resolved.text }); }
          catch { /* operator callback errors must not poison kernel routing */ }
        }
        else this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
      case 'ANSWER':
        // Only an input-required task can be answered; stale answers to closed
        // tasks and answers to unknown taskIds stay logged (message event above)
        // but are not acted on — this also keeps phantom tasks out of the state.
        if (this.taskStateOf(resolved.taskId) !== 'input-required') break;
        this.log.append('task.state', { taskId: resolved.taskId, state: 'working' });
        this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
      case 'REPORT':
        if (resolved.to !== 'operator') this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
      case 'DELIVER': {
        this.log.append('task.state', { taskId: resolved.taskId, state: 'completed' });
        if (resolved.to === 'operator') {
          this.finish({ status: 'completed', result: resolved.text, totalCostUsd: this.budget.totalUsd }, 'mission.completed', { result: resolved.text });
        } else {
          this.nodes.get(resolved.to)?.enqueue(resolved);
        }
        break;
      }
    }
  }

  private handleTurnEnd(nodeId: string, finalText: string): void {
    const node = this.nodes.get(nodeId)!;
    const taskState = this.taskStateOf(node.spec.taskId);
    if (taskState !== 'working' || !finalText.trim()) return;
    // WHY the pending guard: queued messages (e.g. crew DELIVERs that raced in
    // during this very turn) mean another turn is coming — this turn's text is
    // narration, not the deliverable. Without it, fast crew make the captain's
    // "awaiting crew" auto-deliver as the mission result.
    if (node.hasPending) return;
    const openChild = [...this.nodes.values()].some(n =>
      n.spec.parentId === nodeId && ['submitted', 'working', 'input-required'].includes(this.taskStateOf(n.spec.taskId)));
    if (openChild) return;
    // Auto-deliver fallback: the model ended its turn without calling deliver.
    this.route({ kind: 'DELIVER', from: nodeId, to: node.spec.parentId, taskId: node.spec.taskId, text: finalText, auto: true });
  }

  private checkWatchdog(): void {
    if (this.done) return;
    const s = this.state();
    const now = Date.now();
    for (const n of Object.values(s.nodes)) {
      if (this.done) return; // a callback may have cancelled mid-loop
      if (this.watchdogFired.has(n.id)) continue;
      if (s.tasks[n.taskId]?.state !== 'working') continue;
      if (now - new Date(n.lastTs).getTime() < this.config.watchdogMs) continue;
      this.watchdogFired.add(n.id);
      this.log.append('watchdog', { nodeId: n.id });
      const text = `watchdog: ${n.id} silent for over ${Math.round(this.config.watchdogMs / 60_000)} min`;
      this.log.append('message', { kind: 'ESCALATE', from: n.id, to: 'operator', taskId: n.taskId, text });
      // WHY input-required: the operator's designed reply is answerEscalation(taskId, …);
      // without this transition the ANSWER guard would silently drop that reply.
      this.log.append('task.state', { taskId: n.taskId, state: 'input-required' });
      try { this.escalationCb?.({ taskId: n.taskId, from: n.id, text }); }
      catch { /* operator callback errors must not poison kernel routing */ }
    }
  }

  private handleModelFailure(nodeId: string, error: string): void {
    if (error.includes('BudgetExceededError')) {
      this.finish({ status: 'failed', reason: 'budget-exceeded', totalCostUsd: this.budget.totalUsd }, 'mission.failed', { reason: 'budget-exceeded' });
      return;
    }
    const node = this.nodes.get(nodeId)!;
    this.log.append('task.state', { taskId: node.spec.taskId, state: 'failed' });
    this.route({ kind: 'ESCALATE', from: nodeId, to: node.spec.parentId, taskId: node.spec.taskId, text: `node failed after retry: ${error}` });
  }
}
