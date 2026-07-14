# Flota v0.1 — Kernel + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Flota coordination kernel (event-sourced, hierarchical, multi-provider) and the terminal CLI, ending with a real demo mission: a captain decomposing a literature scan across crew on two providers.

**Architecture:** Per `docs/specs/2026-07-13-flota-design.md`. Everything is an event appended to one JSONL log per mission; fleet state is a reducer over that log. Agent nodes are inbox-driven loops around Vercel AI SDK `generateText` calls; delegation is a tool whose execution spawns a child node. The kernel enforces all safety rails (depth/children/concurrency caps, budget refusal, retry-then-escalate, watchdog, wall-clock timeout, cancel). The CLI starts a per-mission kernel, tails events as lines, and answers operator escalations inline. The Tauri observatory is a **separate later plan** — nothing in this plan may depend on it.

**Tech Stack:** Node ≥ 20, TypeScript ^5 (ESM), npm workspaces (`kernel/`, `cli/`), Vercel AI SDK `ai@^5` + `@ai-sdk/anthropic@^2` + `@ai-sdk/openai@^2`, `zod@^3.25`, `vitest@^3`, `tsx`, `commander@^13`, `picocolors`.

## Global Constraints

- Message kinds: `ORDER` (down), `REPORT` (up), `DELIVER` (up), `ESCALATE` (up), `ANSWER` (down, resolves an ESCALATE on the same taskId — the A2A "message to an input-required task" move). No other kinds.
- Task states, A2A names verbatim: `submitted / working / input-required / completed / failed / canceled / rejected` (`auth-required` unused in v0.1).
- Safety-rail defaults (spec §4): `budgetUsd: 5`, `maxDepth: 2` (captain=1, crew=2), `maxChildren: 5`, `maxConcurrentNodes: 8`, `watchdogMs: 300_000`, `missionTimeoutMs: 1_800_000`, retry budget 1 then escalate. Kernel **refuses** model calls past budget.
- No daemons: the kernel is constructed, runs one mission, and its process exits.
- Runtime artifacts live under `missions/<missionId>/` (`events.jsonl`, `workspace/`) — already gitignored.
- Crew file tools may touch **only** `missions/<id>/workspace/` (path-escape guarded).
- Tests never call real provider APIs — always `MockLanguageModelV2` from `ai/test` via the `modelFactory` injection point. Only Task 13 (manual verification) uses live keys.
- If the installed AI SDK minor version's shapes differ from this plan (e.g. mock result fields), consult `node_modules/ai/test.d.ts` and adapt the mocks/plumbing — never the test assertions' observable behavior.
- All commits end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run all tests from repo root with `npx vitest run` (workspaces are auto-discovered via `test.projects` in root `vitest.config.ts` — the separate workspace file is deprecated in vitest 3).

## File Structure

```
package.json                 # workspaces root, scripts
tsconfig.base.json           # shared strict TS config
vitest.workspace.ts
kernel/
  package.json               # @flota/kernel
  tsconfig.json
  src/types.ts               # events, messages, states, config — the vocabulary
  src/log.ts                 # EventLog: append-only JSONL + subscribe + load
  src/reducer.ts             # fold events → FleetState
  src/budget.ts              # cost math + cap enforcement
  src/providers.ts           # provider name → AI SDK model (injection point)
  src/tools/files.ts         # sandboxed read/write/list tools
  src/tools/coordination.ts  # delegate/report/deliver/escalate/answer tools
  src/node.ts                # AgentNode: inbox loop around generateText
  src/kernel.ts              # Mission: spawn/route/rails/completion
  src/index.ts               # public exports
  test/helpers.ts            # scripted mock models
  test/*.test.ts
cli/
  package.json               # @flota/cli, bin: flota
  tsconfig.json
  src/render.ts              # FleetEvent → colored terminal line
  src/run.ts                 # run command: kernel + tail + escalation prompt
  src/replay.ts              # replay command: stepper over events.jsonl
  src/index.ts               # commander wiring
  test/render.test.ts
  test/replay.test.ts
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `kernel/package.json`, `kernel/tsconfig.json`, `cli/package.json`, `cli/tsconfig.json`, `kernel/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo where `npm install` and `npx vitest run` work; every later task assumes this layout.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "flota",
  "private": true,
  "type": "module",
  "workspaces": ["kernel", "cli"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b kernel cli"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "outDir": "dist"
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['kernel', 'cli'] } });
```

- [ ] **Step 2: Workspace manifests**

`kernel/package.json`:
```json
{
  "name": "@flota/kernel",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "ai": "^5.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/openai": "^2.0.0",
    "zod": "^3.25.0"
  }
}
```

`kernel/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```

`cli/package.json`:
```json
{
  "name": "@flota/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "flota": "src/index.ts" },
  "dependencies": {
    "@flota/kernel": "*",
    "commander": "^13.0.0",
    "picocolors": "^1.1.0"
  }
}
```

`cli/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"], "references": [{ "path": "../kernel" }] }
```

- [ ] **Step 3: Smoke test**

`kernel/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
describe('scaffold', () => {
  it('runs tests', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 4: Install and verify**

Run: `npm install && npx vitest run`
Expected: 1 test file, 1 passed.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts kernel cli package-lock.json
git commit -m "chore: scaffold npm-workspaces monorepo (kernel, cli)"
```

---

### Task 2: Vocabulary types + EventLog

**Files:**
- Create: `kernel/src/types.ts`, `kernel/src/log.ts`
- Test: `kernel/test/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types: `Provider ('anthropic'|'openai')`, `TaskState`, `MessageKind`, `FleetMessage { kind: MessageKind; from: string; to: string; taskId: string; parentTaskId?: string; text: string; auto?: boolean }`, `FleetEvent { eventId: string; seq: number; ts: string; missionId: string; type: EventType; data: Record<string, unknown> }`, `EventType ('mission.started'|'node.spawned'|'message'|'task.state'|'tool.called'|'usage'|'watchdog'|'mission.completed'|'mission.canceled'|'mission.failed')`, `MissionConfig` (all rail defaults from Global Constraints + `models: { captain: ModelRef; crew: ModelRef[] }`, `ModelRef { provider: Provider; model: string }`, `pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>`), `defaultConfig(): MissionConfig`.
  - `class EventLog { constructor(missionId: string, filePath?: string); append(type: EventType, data: Record<string, unknown>): FleetEvent; readonly events: FleetEvent[]; subscribe(fn: (e: FleetEvent) => void): () => void; static load(filePath: string): FleetEvent[] }`

- [ ] **Step 1: Write the failing test**

`kernel/test/log.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/log.js';

describe('EventLog', () => {
  it('assigns monotonic seq and timestamps', () => {
    const log = new EventLog('m-test');
    const a = log.append('mission.started', { order: 'x' });
    const b = log.append('node.spawned', { nodeId: 'captain' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.missionId).toBe('m-test');
    expect(new Date(a.ts).getTime()).toBeGreaterThan(0);
    expect(log.events).toHaveLength(2);
  });

  it('notifies subscribers and honors unsubscribe', () => {
    const log = new EventLog('m-test');
    const seen: string[] = [];
    const unsub = log.subscribe(e => seen.push(e.type));
    log.append('mission.started', {});
    unsub();
    log.append('mission.completed', {});
    expect(seen).toEqual(['mission.started']);
  });

  it('persists JSONL and round-trips via load', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-')), 'events.jsonl');
    const log = new EventLog('m-test', file);
    log.append('mission.started', { order: 'scan' });
    log.append('mission.completed', { result: 'ok' });
    const loaded = EventLog.load(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].data).toEqual({ order: 'scan' });
    expect(loaded[1].seq).toBe(2);
  });

  it('load skips unparseable lines instead of throwing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-')), 'events.jsonl');
    const log = new EventLog('m-test', file);
    log.append('mission.started', { order: 'scan' });
    log.append('mission.completed', { result: 'ok' });
    appendFileSync(file, '{"eventId":"trunc'); // simulated truncated final write
    const loaded = EventLog.load(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[1].type).toBe('mission.completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/log.test.ts`
Expected: FAIL — cannot resolve `../src/log.js`.

- [ ] **Step 3: Implement**

`kernel/src/types.ts`:
```ts
export type Provider = 'anthropic' | 'openai';

export type TaskState =
  | 'submitted' | 'working' | 'input-required'
  | 'completed' | 'failed' | 'canceled' | 'rejected';

export type MessageKind = 'ORDER' | 'REPORT' | 'DELIVER' | 'ESCALATE' | 'ANSWER';

export interface FleetMessage {
  kind: MessageKind;
  from: string;           // nodeId or 'operator'
  to: string;             // nodeId or 'operator'
  taskId: string;
  parentTaskId?: string;
  text: string;
  auto?: boolean;         // true when kernel auto-delivered a node's final text
}

export type EventType =
  | 'mission.started' | 'node.spawned' | 'message' | 'task.state'
  | 'tool.called' | 'usage' | 'watchdog'
  | 'mission.completed' | 'mission.canceled' | 'mission.failed';

export interface FleetEvent {
  eventId: string;
  seq: number;
  ts: string;             // ISO 8601
  missionId: string;
  type: EventType;
  data: Record<string, unknown>;
}

export interface ModelRef { provider: Provider; model: string }

export interface MissionConfig {
  budgetUsd: number;
  maxDepth: number;
  maxChildren: number;
  maxConcurrentNodes: number;
  watchdogMs: number;
  missionTimeoutMs: number;
  maxStepsPerTurn: number;
  models: { captain: ModelRef; crew: ModelRef[] };
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

// WHY these model ids/prices: current defaults at design time (2026-07);
// they live in config, not code, so Task 13 can correct them without a code change.
export function defaultConfig(): MissionConfig {
  return {
    budgetUsd: 5,
    maxDepth: 2,
    maxChildren: 5,
    maxConcurrentNodes: 8,
    watchdogMs: 300_000,
    missionTimeoutMs: 1_800_000,
    maxStepsPerTurn: 12,
    models: {
      captain: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      crew: [
        { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        { provider: 'openai', model: 'gpt-5.1' },
      ],
    },
    pricing: {
      'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
      'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
    },
  };
}
```

`kernel/src/log.ts`:
```ts
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
      .flatMap(line => {
        // WHY the guard: a truncated or hand-edited last line must not make a
        // mission's entire history unreadable — skip what can't be parsed.
        try { return [JSON.parse(line) as FleetEvent]; }
        catch { return []; }
      });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/log.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/types.ts kernel/src/log.ts kernel/test/log.test.ts
git commit -m "feat(kernel): vocabulary types and append-only EventLog"
```

---

### Task 3: Reducer — events → FleetState

**Files:**
- Create: `kernel/src/reducer.ts`
- Test: `kernel/test/reducer.test.ts`

**Interfaces:**
- Consumes: `FleetEvent`, `TaskState`, `FleetMessage` from Task 2.
- Produces:
  ```ts
  interface NodeView { id: string; parentId?: string; role: string; provider: string; model: string; taskId: string; costUsd: number; lastTs: string }
  interface TaskView { id: string; parentTaskId?: string; assignee: string; state: TaskState }
  interface EscalationView { taskId: string; from: string; text: string }
  interface FleetState {
    missionId: string; order: string;
    status: 'running' | 'completed' | 'canceled' | 'failed';
    nodes: Record<string, NodeView>;
    tasks: Record<string, TaskView>;
    openEscalations: EscalationView[];
    totalCostUsd: number;
    result?: string;
  }
  function reduce(events: FleetEvent[]): FleetState
  function nodeState(state: FleetState, nodeId: string): TaskState  // state of the node's own task
  ```

- [ ] **Step 1: Write the failing test**

`kernel/test/reducer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EventLog } from '../src/log.js';
import { reduce, nodeState } from '../src/reducer.js';

function sampleLog(): EventLog {
  const log = new EventLog('m-1');
  log.append('mission.started', { order: 'scan fairness metrics' });
  log.append('node.spawned', { nodeId: 'captain', role: 'captain', provider: 'anthropic', model: 'claude-sonnet-4-5', taskId: 't1' });
  log.append('task.state', { taskId: 't1', assignee: 'captain', state: 'working' });
  log.append('node.spawned', { nodeId: 'crew-1', parentId: 'captain', role: 'metrics-scan', provider: 'openai', model: 'gpt-5.1', taskId: 't2' });
  log.append('task.state', { taskId: 't2', parentTaskId: 't1', assignee: 'crew-1', state: 'working' });
  log.append('usage', { nodeId: 'crew-1', costUsd: 0.12 });
  log.append('message', { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'include non-ICU?' });
  log.append('task.state', { taskId: 't2', state: 'input-required' });
  return log;
}

describe('reduce', () => {
  it('projects nodes, tasks, escalations, cost', () => {
    const s = reduce(sampleLog().events);
    expect(s.status).toBe('running');
    expect(s.order).toBe('scan fairness metrics');
    expect(Object.keys(s.nodes)).toEqual(['captain', 'crew-1']);
    expect(s.nodes['crew-1'].parentId).toBe('captain');
    expect(s.tasks['t2'].state).toBe('input-required');
    expect(s.openEscalations).toEqual([{ taskId: 't2', from: 'crew-1', text: 'include non-ICU?' }]);
    expect(s.totalCostUsd).toBeCloseTo(0.12);
    expect(nodeState(s, 'crew-1')).toBe('input-required');
  });

  it('ANSWER clears the escalation; DELIVER completes; mission terminates', () => {
    const log = sampleLog();
    log.append('message', { kind: 'ANSWER', from: 'captain', to: 'crew-1', taskId: 't2', text: 'yes, include' });
    log.append('task.state', { taskId: 't2', state: 'working' });
    log.append('message', { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'found 12 metrics' });
    log.append('task.state', { taskId: 't2', state: 'completed' });
    log.append('mission.completed', { result: 'brief text' });
    const s = reduce(log.events);
    expect(s.openEscalations).toEqual([]);
    expect(s.tasks['t2'].state).toBe('completed');
    expect(s.status).toBe('completed');
    expect(s.result).toBe('brief text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/reducer.test.ts`
Expected: FAIL — cannot resolve `../src/reducer.js`.

- [ ] **Step 3: Implement**

`kernel/src/reducer.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/reducer.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/reducer.ts kernel/test/reducer.test.ts
git commit -m "feat(kernel): reducer projecting events into FleetState"
```

---

### Task 4: Budget — cost math + cap enforcement

**Files:**
- Create: `kernel/src/budget.ts`
- Test: `kernel/test/budget.test.ts`

**Interfaces:**
- Consumes: `MissionConfig['pricing']` from Task 2.
- Produces:
  ```ts
  class BudgetExceededError extends Error { constructor(public spentUsd: number, public capUsd: number) }
  class BudgetTracker {
    constructor(pricing: MissionConfig['pricing'], missionCapUsd: number);
    addUsage(nodeId: string, model: string, usage: { inputTokens: number; outputTokens: number }): number; // returns costUsd of this usage
    get totalUsd(): number;
    nodeUsd(nodeId: string): number;
    assertUnderCap(): void; // throws BudgetExceededError when totalUsd >= cap
  }
  ```

- [ ] **Step 1: Write the failing test**

`kernel/test/budget.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BudgetTracker, BudgetExceededError } from '../src/budget.js';

const pricing = { m1: { inputPerMTok: 3, outputPerMTok: 15 } };

describe('BudgetTracker', () => {
  it('computes cost from token usage', () => {
    const b = new BudgetTracker(pricing, 5);
    const cost = b.addUsage('n1', 'm1', { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(3 + 1.5);
    expect(b.totalUsd).toBeCloseTo(4.5);
    expect(b.nodeUsd('n1')).toBeCloseTo(4.5);
  });

  it('unknown model is priced at the most expensive configured rate (never under-counts)', () => {
    const b = new BudgetTracker(pricing, 5);
    const cost = b.addUsage('n1', 'mystery', { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(4.5); // priced as m1 — the only, hence max, configured rate
  });

  it('assertUnderCap throws at exact cap equality', () => {
    const b = new BudgetTracker({ m1: { inputPerMTok: 1, outputPerMTok: 1 } }, 1);
    b.addUsage('n1', 'm1', { inputTokens: 1_000_000, outputTokens: 0 }); // exactly $1.00
    expect(() => b.assertUnderCap()).toThrow(BudgetExceededError);
  });

  it('assertUnderCap throws once the cap is reached', () => {
    const b = new BudgetTracker(pricing, 1);
    b.assertUnderCap(); // fine at 0 spend
    b.addUsage('n1', 'm1', { inputTokens: 400_000, outputTokens: 0 }); // $1.20
    expect(() => b.assertUnderCap()).toThrow(BudgetExceededError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/budget.test.ts`
Expected: FAIL — cannot resolve `../src/budget.js`.

- [ ] **Step 3: Implement**

`kernel/src/budget.ts`:
```ts
import type { MissionConfig } from './types.js';

export class BudgetExceededError extends Error {
  constructor(public spentUsd: number, public capUsd: number) {
    super(`budget exceeded: $${spentUsd.toFixed(2)} >= cap $${capUsd.toFixed(2)}`);
    // WHY: the kernel identifies this error via String(err).includes(this.name)
    // after it crosses the node retry boundary — the name is codebase-owned and
    // cannot collide with provider error text the way the message could.
    this.name = 'BudgetExceededError';
  }
}

export class BudgetTracker {
  private perNode = new Map<string, number>();
  private total = 0;

  constructor(private pricing: MissionConfig['pricing'], private missionCapUsd: number) {}

  addUsage(nodeId: string, model: string, usage: { inputTokens: number; outputTokens: number }): number {
    // WHY the fallback: an unrecognized model id must never silently count $0
    // toward the hard cap — price it at the most expensive configured rate instead.
    const rates = Object.values(this.pricing);
    const p = this.pricing[model]
      ?? (rates.length ? rates.reduce((a, b) => (a.inputPerMTok + a.outputPerMTok >= b.inputPerMTok + b.outputPerMTok ? a : b)) : undefined);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/budget.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/budget.ts kernel/test/budget.test.ts
git commit -m "feat(kernel): budget tracker with hard mission cap"
```

---

### Task 5: Provider registry (the mock-injection point)

**Files:**
- Create: `kernel/src/providers.ts`
- Test: `kernel/test/providers.test.ts`

**Interfaces:**
- Consumes: `ModelRef` from Task 2.
- Produces:
  ```ts
  type ModelFactory = (ref: ModelRef) => LanguageModel;   // LanguageModel from 'ai'
  const realModelFactory: ModelFactory;                    // anthropic()/openai() per ref.provider
  ```
  Every consumer (node, kernel) takes a `ModelFactory` — tests pass a factory returning `MockLanguageModelV2`.

- [ ] **Step 1: Write the failing test**

`kernel/test/providers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { realModelFactory } from '../src/providers.js';

describe('realModelFactory', () => {
  it('resolves both providers to model instances carrying the model id', () => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key';
    process.env.OPENAI_API_KEY ??= 'test-key';
    const a = realModelFactory({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    const o = realModelFactory({ provider: 'openai', model: 'gpt-5.1' });
    expect(a.modelId).toBe('claude-sonnet-4-5');
    expect(o.modelId).toBe('gpt-5.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/providers.test.ts`
Expected: FAIL — cannot resolve `../src/providers.js`.

- [ ] **Step 3: Implement**

`kernel/src/providers.ts`:
```ts
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelRef } from './types.js';

export type ModelFactory = (ref: ModelRef) => LanguageModel;

export const realModelFactory: ModelFactory = (ref) =>
  ref.provider === 'anthropic' ? anthropic(ref.model) : openai(ref.model);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/providers.test.ts`
Expected: 1 passed. (If `modelId` is named differently in the installed SDK, check `node_modules/ai/dist/index.d.ts` and assert on the correct property.)

- [ ] **Step 5: Commit**

```bash
git add kernel/src/providers.ts kernel/test/providers.test.ts
git commit -m "feat(kernel): provider registry as injectable ModelFactory"
```

---

### Task 6: Sandboxed file tools

**Files:**
- Create: `kernel/src/tools/files.ts`
- Test: `kernel/test/files.test.ts`

**Interfaces:**
- Consumes: `tool` + `zod` from the AI SDK stack.
- Produces: `makeFileTools(workspaceDir: string): ToolSet` with tools `write_file({ path, content })`, `read_file({ path })`, `list_files({})` — every path resolved inside `workspaceDir`, escapes rejected with the string `'error: path escapes workspace'`.

- [ ] **Step 1: Write the failing test**

`kernel/test/files.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileTools } from '../src/tools/files.js';

const opts = { toolCallId: 't', messages: [] as any[] };

describe('file tools sandbox', () => {
  it('writes, lists, reads inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'flota-ws-'));
    const tools = makeFileTools(ws) as any;
    await tools.write_file.execute({ path: 'notes/a.md', content: 'hello' }, opts);
    const listing = await tools.list_files.execute({}, opts);
    expect(listing).toContain('notes/a.md');
    const content = await tools.read_file.execute({ path: 'notes/a.md' }, opts);
    expect(content).toBe('hello');
  });

  it('rejects path escapes', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'flota-ws-'));
    const tools = makeFileTools(ws) as any;
    const r1 = await tools.write_file.execute({ path: '../evil.txt', content: 'x' }, opts);
    const r2 = await tools.read_file.execute({ path: '/etc/passwd' }, opts);
    expect(r1).toBe('error: path escapes workspace');
    expect(r2).toBe('error: path escapes workspace');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/files.test.ts`
Expected: FAIL — cannot resolve `../src/tools/files.js`.

- [ ] **Step 3: Implement**

`kernel/src/tools/files.ts`:
```ts
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, sep, relative } from 'node:path';

function resolveSafe(workspaceDir: string, p: string): string | null {
  const full = resolve(workspaceDir, p);
  // WHY the sep suffix: prevents `${workspaceDir}-evil` prefix matches
  return full === workspaceDir || full.startsWith(workspaceDir + sep) ? full : null;
}

export function makeFileTools(workspaceDir: string): ToolSet {
  return {
    write_file: tool({
      description: 'Write a text file inside your mission workspace.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const full = resolveSafe(workspaceDir, path);
        if (!full) return 'error: path escapes workspace';
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        return `wrote ${path}`;
      },
    }),
    read_file: tool({
      description: 'Read a text file from your mission workspace.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const full = resolveSafe(workspaceDir, path);
        if (!full) return 'error: path escapes workspace';
        try { return readFileSync(full, 'utf8'); } catch { return `error: ${path} not found`; }
      },
    }),
    list_files: tool({
      description: 'List all files in your mission workspace.',
      inputSchema: z.object({}),
      execute: async () => {
        const walk = (dir: string): string[] =>
          readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(resolve(dir, e.name)) : [relative(workspaceDir, resolve(dir, e.name))]);
        const files = walk(workspaceDir);
        return files.length ? files.join('\n') : '(workspace empty)';
      },
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/files.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/tools/files.ts kernel/test/files.test.ts
git commit -m "feat(kernel): sandboxed file tools with path-escape guard"
```

---

### Task 7: Coordination tools

**Files:**
- Create: `kernel/src/tools/coordination.ts`
- Test: `kernel/test/coordination.test.ts`

**Interfaces:**
- Consumes: `tool`/`zod`; `FleetMessage`, `Provider` from Task 2.
- Produces:
  ```ts
  interface KernelApi {
    delegate(fromNodeId: string, args: { role: string; charter: string; task: string; provider?: Provider; model?: string }): string; // 'spawned <nodeId> (task <taskId>)' or 'refused: <reason>'
    emitMessage(msg: Omit<FleetMessage, 'auto'>): void;
  }
  makeCoordinationTools(ctx: { nodeId: string; taskId: string; parentId: string; captain: boolean }, api: KernelApi): ToolSet
  ```
  Captain nodes (`captain: true`) get `delegate`, `answer`, `deliver`, `escalate`. Crew get `report`, `deliver`, `escalate`. `deliver`/`report`/`escalate` target `ctx.parentId`; `escalate` from a node whose parent is `'operator'` reaches the operator by the same routing.

- [ ] **Step 1: Write the failing test**

`kernel/test/coordination.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { makeCoordinationTools } from '../src/tools/coordination.js';

const opts = { toolCallId: 't', messages: [] as any[] };

function fakeApi() {
  return { delegate: vi.fn().mockReturnValue('spawned crew-1 (task t2)'), emitMessage: vi.fn() };
}

describe('coordination tools', () => {
  it('captain gets delegate+answer, crew gets report; both get deliver+escalate', () => {
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, fakeApi());
    const crew = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, fakeApi());
    expect(Object.keys(cap).sort()).toEqual(['answer', 'delegate', 'deliver', 'escalate']);
    expect(Object.keys(crew).sort()).toEqual(['deliver', 'escalate', 'report']);
  });

  it('delegate relays kernel refusals verbatim to the model', async () => {
    const api = fakeApi();
    api.delegate.mockReturnValue('refused: depth cap reached');
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, api) as any;
    const out = await cap.delegate.execute({ role: 'x', charter: 'y', task: 'z' }, opts);
    expect(out).toBe('refused: depth cap reached');
  });

  it('deliver and escalate emit correctly-addressed messages', async () => {
    const api = fakeApi();
    const crew = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, api) as any;
    await crew.deliver.execute({ text: 'result text' }, opts);
    await crew.escalate.execute({ question: 'which scope?' }, opts);
    expect(api.emitMessage).toHaveBeenNthCalledWith(1, { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'result text' });
    expect(api.emitMessage).toHaveBeenNthCalledWith(2, { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'which scope?' });
  });

  it('answer targets the escalating task, not the captain task', async () => {
    const api = fakeApi();
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, api) as any;
    await cap.answer.execute({ taskId: 't2', text: 'include both' }, opts);
    expect(api.emitMessage).toHaveBeenCalledWith({ kind: 'ANSWER', from: 'captain', to: '', taskId: 't2', text: 'include both' });
  });
});
```

Note: `answer` addresses by `taskId`; the kernel resolves `to` from the task's assignee, so the tool emits `to: ''`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/coordination.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

`kernel/src/tools/coordination.ts`:
```ts
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { FleetMessage, Provider } from '../types.js';

export interface KernelApi {
  delegate(fromNodeId: string, args: { role: string; charter: string; task: string; provider?: Provider; model?: string }): string;
  emitMessage(msg: Omit<FleetMessage, 'auto'>): void;
}

export interface ToolCtx { nodeId: string; taskId: string; parentId: string; captain: boolean }

export function makeCoordinationTools(ctx: ToolCtx, api: KernelApi): ToolSet {
  const deliver = tool({
    description: 'Deliver your finished work product for your current task. Ends your task.',
    inputSchema: z.object({ text: z.string().describe('the complete work product') }),
    execute: async ({ text }) => {
      api.emitMessage({ kind: 'DELIVER', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text });
      return 'delivered';
    },
  });
  const escalate = tool({
    description: 'Escalate a decision you cannot make yourself. Pauses your task until answered.',
    inputSchema: z.object({ question: z.string() }),
    execute: async ({ question }) => {
      api.emitMessage({ kind: 'ESCALATE', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text: question });
      return 'escalated — you will be woken when answered';
    },
  });

  if (ctx.captain) {
    return {
      delegate: tool({
        description: 'Spawn a crew agent to work a subtask in parallel. Returns immediately; results arrive later as DELIVER messages.',
        inputSchema: z.object({
          role: z.string().describe('short role name, e.g. metrics-scan'),
          charter: z.string().describe('the crew agent\'s role instructions'),
          task: z.string().describe('the concrete task order'),
          provider: z.enum(['anthropic', 'openai']).optional(),
          model: z.string().optional(),
        }),
        execute: async (args) => api.delegate(ctx.nodeId, args),
      }),
      answer: tool({
        description: 'Answer an escalation from one of your crew, resuming their task.',
        inputSchema: z.object({ taskId: z.string(), text: z.string() }),
        execute: async ({ taskId, text }) => {
          api.emitMessage({ kind: 'ANSWER', from: ctx.nodeId, to: '', taskId, text });
          return 'answered';
        },
      }),
      deliver, escalate,
    };
  }
  return {
    report: tool({
      description: 'Report interim progress upward without ending your task.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        api.emitMessage({ kind: 'REPORT', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text });
        return 'reported';
      },
    }),
    deliver, escalate,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run kernel/test/coordination.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/tools/coordination.ts kernel/test/coordination.test.ts
git commit -m "feat(kernel): delegate/report/deliver/escalate/answer tools"
```

---

### Task 8: Scripted mock models + AgentNode

**Files:**
- Create: `kernel/test/helpers.ts`, `kernel/src/node.ts`
- Test: `kernel/test/node.test.ts`

**Interfaces:**
- Consumes: `EventLog` (T2), `ToolSet`s (T6, T7), `LanguageModel`.
- Produces:
  ```ts
  interface NodeSpec { id: string; parentId: string; role: string; charter: string; taskId: string; depth: number; captain: boolean }
  interface NodeDeps {
    model: LanguageModel;
    tools: ToolSet;
    log: EventLog;
    maxStepsPerTurn: number;
    beforeModelCall(): void;                       // kernel budget gate — may throw
    onUsage(nodeId: string, usage: { inputTokens: number; outputTokens: number }): void;
    onTurnEnd(nodeId: string, finalText: string): void;   // kernel auto-deliver fallback hook
    onModelFailure(nodeId: string, error: string): void;  // kernel escalates after retry exhausted
    abortSignal: AbortSignal;
  }
  class AgentNode {
    constructor(spec: NodeSpec, deps: NodeDeps);
    enqueue(msg: FleetMessage): void;   // wakes the loop if idle
    get busy(): boolean;
    readonly spec: NodeSpec;
  }
  ```
  Turn semantics: drain queued messages → append as one user message (`[KIND from <id> · task <taskId>] <text>` per line) → `generateText({ model, system: charter, messages, tools, stopWhen: stepCountIs(maxStepsPerTurn), abortSignal })` → append `result.response.messages` to transcript → emit usage → if more messages queued, loop; else call `onTurnEnd` with the final text. Model call errors retry exactly once, then `onModelFailure`.
- Test helper produced: `scriptedModel(turns: Array<Array<{ toolName?: string; input?: object; text?: string }>>): MockLanguageModelV2` — each `doGenerate` call consumes the next scripted step within the current turn.

- [ ] **Step 1: Write the test helper**

`kernel/test/helpers.ts`:
```ts
import { MockLanguageModelV2 } from 'ai/test';

/**
 * Scripted mock: outer array = successive doGenerate calls; each entry is the
 * content the model "responds" with — either a tool call or plain text.
 */
export function scriptedModel(calls: Array<{ toolName?: string; input?: object; text?: string }>): MockLanguageModelV2 {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      const step = calls[Math.min(i++, calls.length - 1)];
      const content = step.toolName
        ? [{ type: 'tool-call' as const, toolCallId: `call-${i}`, toolName: step.toolName, input: JSON.stringify(step.input ?? {}) }]
        : [{ type: 'text' as const, text: step.text ?? '' }];
      return {
        finishReason: step.toolName ? ('tool-calls' as const) : ('stop' as const),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        content,
        warnings: [],
      };
    },
  });
}

export function failingThenTextModel(failures: number, text: string): MockLanguageModelV2 {
  let n = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      if (n++ < failures) throw new Error('simulated API error');
      return {
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        content: [{ type: 'text' as const, text }],
        warnings: [],
      };
    },
  });
}
```

- [ ] **Step 2: Write the failing tests**

`kernel/test/node.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { EventLog } from '../src/log.js';
import { AgentNode } from '../src/node.js';
import { makeCoordinationTools } from '../src/tools/coordination.js';
import { scriptedModel, failingThenTextModel } from './helpers.js';

function deps(model: any, tools: any, log = new EventLog('m-t')) {
  return {
    model, tools, log,
    maxStepsPerTurn: 12,
    beforeModelCall: vi.fn(),
    onUsage: vi.fn(),
    onTurnEnd: vi.fn(),
    onModelFailure: vi.fn(),
    abortSignal: new AbortController().signal,
    _log: log,
  };
}
const spec = { id: 'crew-1', parentId: 'captain', role: 'scan', charter: 'You scan.', taskId: 't2', depth: 2, captain: false };
const order = { kind: 'ORDER' as const, from: 'captain', to: 'crew-1', taskId: 't2', text: 'scan metrics' };
const flush = () => new Promise(r => setTimeout(r, 50));

describe('AgentNode', () => {
  it('runs a turn: tool call then final text, reporting usage and turn end', async () => {
    const api = { delegate: vi.fn(), emitMessage: vi.fn() };
    const tools = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, api);
    const model = scriptedModel([
      { toolName: 'report', input: { text: 'starting' } },
      { text: 'done scanning' },
    ]);
    const d = deps(model, tools);
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(api.emitMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REPORT', text: 'starting' }));
    expect(d.onUsage).toHaveBeenCalled();
    expect(d.onTurnEnd).toHaveBeenCalledWith('crew-1', 'done scanning');
    expect(node.busy).toBe(false);
  });

  it('retries a failed model call once, then succeeds silently', async () => {
    const d = deps(failingThenTextModel(1, 'recovered'), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(d.onModelFailure).not.toHaveBeenCalled();
    expect(d.onTurnEnd).toHaveBeenCalledWith('crew-1', 'recovered');
  });

  it('reports failure after the retry also fails', async () => {
    const d = deps(failingThenTextModel(2, 'never'), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(d.onModelFailure).toHaveBeenCalledWith('crew-1', expect.stringContaining('simulated API error'));
  });

  it('messages arriving mid-turn run as a follow-up turn on the same transcript', async () => {
    const d = deps(scriptedModel([{ text: 'turn one' }, { text: 'turn two' }]), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    node.enqueue({ kind: 'ANSWER', from: 'captain', to: 'crew-1', taskId: 't2', text: 'proceed' });
    await flush();
    expect(d.onTurnEnd).toHaveBeenCalledTimes(2);
    expect(d.onTurnEnd).toHaveBeenLastCalledWith('crew-1', 'turn two');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run kernel/test/node.test.ts`
Expected: FAIL — cannot resolve `../src/node.js`.

- [ ] **Step 4: Implement**

`kernel/src/node.ts`:
```ts
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { EventLog } from './log.js';
import type { FleetMessage } from './types.js';

export interface NodeSpec {
  id: string; parentId: string; role: string; charter: string;
  taskId: string; depth: number; captain: boolean;
}

export interface NodeDeps {
  model: LanguageModel;
  tools: ToolSet;
  log: EventLog;
  maxStepsPerTurn: number;
  beforeModelCall(): void;
  onUsage(nodeId: string, usage: { inputTokens: number; outputTokens: number }): void;
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
    if (!this.running) void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        const text = batch.map(m => `[${m.kind} from ${m.from} · task ${m.taskId}] ${m.text}`).join('\n\n');
        this.transcript.push({ role: 'user', content: text });
        const result = await this.callModelWithRetry();
        if (!result) return; // failure already reported
        this.transcript.push(...result.response.messages);
        this.deps.onUsage(this.spec.id, {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        });
        this.deps.onTurnEnd(this.spec.id, result.text);
      }
    } finally {
      this.running = false;
    }
  }

  private async callModelWithRetry() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.deps.beforeModelCall();
        return await generateText({
          model: this.deps.model,
          system: this.spec.charter,
          messages: this.transcript,
          tools: this.deps.tools,
          stopWhen: stepCountIs(this.deps.maxStepsPerTurn),
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run kernel/test/node.test.ts`
Expected: 4 passed. (Budget-gate errors from `beforeModelCall` intentionally flow through the same retry/failure path — the kernel distinguishes them in Task 10.)

- [ ] **Step 6: Commit**

```bash
git add kernel/test/helpers.ts kernel/src/node.ts kernel/test/node.test.ts
git commit -m "feat(kernel): AgentNode inbox loop with retry-then-fail semantics"
```

---

### Task 9: Mission kernel — spawn, route, complete (happy path)

**Files:**
- Create: `kernel/src/kernel.ts`, `kernel/src/index.ts`
- Modify: `kernel/src/node.ts` (additive: `hasPending` getter, needed by the auto-deliver pending guard)
- Test: `kernel/test/kernel.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  interface MissionDeps { modelFactory: ModelFactory; missionsDir?: string }  // no missionsDir → in-memory log, temp workspace
  interface MissionResult { status: 'completed' | 'canceled' | 'failed'; result?: string; reason?: string; totalCostUsd: number }
  class Mission {
    constructor(order: string, config: MissionConfig, deps: MissionDeps);
    readonly id: string;
    readonly log: EventLog;
    start(): Promise<MissionResult>;
    onOperatorEscalation(cb: (e: { taskId: string; from: string; text: string }) => void): void;
    answerEscalation(taskId: string, text: string): void;
    cancel(reason: string): void;
    state(): FleetState;   // reduce(log.events)
  }
  ```
  Routing rules (single source of truth, `route(msg)`):
  - every message → `message` event; then per kind: `ORDER` → assignee task `working`; `ESCALATE` → task `input-required`, forward to `to` (if `to === 'operator'`, fire operator callback); `ANSWER` → task `working`, deliver to task assignee; `REPORT` → forward only; `DELIVER` → task `completed`, forward; `DELIVER` addressed to `'operator'` on the root task → `mission.completed`, resolve `start()`.
  - Crew escalations go to their captain (parentId), captain escalations go to `'operator'` — addressing was fixed in Task 7; the kernel only honors it.
  - Auto-deliver fallback (`onTurnEnd`): if the node's task is still `working`, the node has no children with open (`submitted/working/input-required`) tasks, the node's inbox is empty (`!node.hasPending` — queued messages mean another turn is coming; without this guard, zero-latency crew that complete inside the captain's own turn make the captain's incidental turn text auto-deliver as the mission result), and final text is non-empty → emit `DELIVER` with `auto: true`. This is why the happy path terminates even when a model forgets to call `deliver`, independent of crew timing.
  - `delegate` enforcement: refuse (return `'refused: …'` string, log nothing but the `tool.called`) when child depth would exceed `maxDepth`, node's children ≥ `maxChildren`, or live nodes ≥ `maxConcurrentNodes`. Otherwise: create nodeId `<role-slug>-<n>`, taskId `t<n>`, emit `node.spawned` + `task.state(submitted)`, route an `ORDER`.
  - Captain charter (exact system-prompt text, used by `start()`):
    ```
    You are the mission captain of an agent fleet. The operator's order follows as your task.
    Decompose it into parallel subtasks and spawn crew with the delegate tool (each gets a
    focused charter and task). Crew results arrive later as DELIVER messages; answer crew
    ESCALATE questions with the answer tool when you can, escalate to the operator only when
    you genuinely cannot decide. When all crew work is in, synthesize and call deliver with
    the complete final result. Never do large subtasks yourself — delegate.
    ```
  - Crew system prompt = the charter passed to `delegate`, suffixed with:
    ```
    ---
    You are one crew agent in a fleet. Work only your assigned task. Use report for interim
    progress, escalate when you need a decision, and end by calling deliver with your complete
    result. You have file tools scoped to a shared mission workspace.
    ```

- [ ] **Step 1: Write the failing test**

`kernel/test/kernel.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { scriptedModel } from './helpers.js';

describe('Mission happy path', () => {
  it('captain delegates to two crew, crew deliver, mission completes with synthesis', async () => {
    const models: any[] = [];
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'scan-a', charter: 'Scan A.', task: 'scan A', provider: 'anthropic' } },
      { toolName: 'delegate', input: { role: 'scan-b', charter: 'Scan B.', task: 'scan B', provider: 'openai' } },
      { text: 'awaiting crew' },
      { text: 'FINAL BRIEF: A+B synthesized' },
    ]);
    const modelFactory = (ref: any) => {
      if (models.length === 0) { models.push(ref); return captain; }
      models.push(ref);
      return scriptedModel([{ toolName: 'deliver', input: { text: `result for ${ref.provider}` } }, { text: '' }]);
    };
    const mission = new Mission('survey fairness metrics', defaultConfig(), { modelFactory });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL BRIEF: A+B synthesized');
    // both crew providers were requested as delegated
    expect(models.map((m: any) => m.provider)).toEqual(['anthropic', 'anthropic', 'openai']);
    const s = mission.state();
    expect(Object.keys(s.nodes)).toHaveLength(3); // captain + 2 crew
    expect(s.totalCostUsd).toBeGreaterThan(0);
    expect(s.tasks['t1'].state).toBe('completed');
  });

  it('escalation reaches the operator and an answer resumes the branch', async () => {
    const captain = scriptedModel([
      { toolName: 'escalate', input: { question: 'which venue scope?' } },
      { text: 'awaiting operator' },
      { text: 'FINAL: scoped brief' },
    ]);
    const mission = new Mission('do a thing', defaultConfig(), { modelFactory: () => captain });
    const escalations: any[] = [];
    mission.onOperatorEscalation(e => {
      escalations.push(e);
      setTimeout(() => mission.answerEscalation(e.taskId, 'scope to ICU only'), 10);
    });
    const res = await mission.start();
    expect(escalations).toEqual([{ taskId: 't1', from: 'captain', text: 'which venue scope?' }]);
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL: scoped brief');
  });

  it('delegate is refused beyond maxChildren', async () => {
    const cfg = { ...defaultConfig(), maxChildren: 1 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { toolName: 'delegate', input: { role: 'b', charter: 'c', task: 't' } },
      { text: 'FINAL: done with one crew' },
    ]);
    // first modelFactory call is the captain, later calls are crew
    let first = true;
    const mission = new Mission('x', cfg, {
      modelFactory: () => (first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }])),
    });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    const s = mission.state();
    expect(Object.keys(s.nodes)).toHaveLength(2); // captain + only 1 crew
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run kernel/test/kernel.test.ts`
Expected: FAIL — cannot resolve `../src/kernel.js`.

- [ ] **Step 3: Implement**

`kernel/src/kernel.ts` (rails beyond caps — budget refusal, watchdog, timeout, cancel — land in Task 10; leave the marked hooks in place):
```ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from './log.js';
import { reduce, type FleetState } from './reducer.js';
import { BudgetTracker } from './budget.js';
import { AgentNode } from './node.js';
import { makeFileTools } from './tools/files.js';
import { makeCoordinationTools, type KernelApi } from './tools/coordination.js';
import type { ModelFactory } from './providers.js';
import type { FleetMessage, MissionConfig, Provider, TaskState } from './types.js';

export interface MissionDeps { modelFactory: ModelFactory; missionsDir?: string }
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

  constructor(private order: string, private config: MissionConfig, private deps: MissionDeps) {
    this.id = `m-${Date.now().toString(36)}`;
    if (deps.missionsDir) {
      const dir = join(deps.missionsDir, this.id);
      this.workspaceDir = join(dir, 'workspace');
      mkdirSync(this.workspaceDir, { recursive: true });
      this.log = new EventLog(this.id, join(dir, 'events.jsonl'));
    } else {
      this.workspaceDir = mkdtempSync(join(tmpdir(), 'flota-ws-'));
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
    // Task 10 adds: watchdog interval + mission wall-clock timeout here.
    return promise;
  }

  private finish(result: MissionResult, eventType: 'mission.completed' | 'mission.canceled' | 'mission.failed', data: Record<string, unknown>): void {
    if (this.done) return;
    this.done = true;
    this.abort.abort();
    this.log.append(eventType, data);
    this.resolveResult(result);
  }

  private taskStateOf(taskId: string): TaskState { return this.state().tasks[taskId]?.state; }

  private spawn(parentId: string, depth: number, captain: boolean, role: string, charter: string, ref: { provider: Provider; model: string }): string {
    this.counter++;
    const nodeId = captain ? 'captain' : `${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.counter}`;
    const taskId = `t${this.counter}`;
    const parentTaskId = parentId === 'operator' ? undefined : this.nodes.get(parentId)?.spec.taskId;
    this.log.append('node.spawned', { nodeId, parentId: parentId === 'operator' ? undefined : parentId, role, provider: ref.provider, model: ref.model, taskId });
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
        model: this.deps.modelFactory(ref),
        tools,
        log: this.log,
        maxStepsPerTurn: this.config.maxStepsPerTurn,
        beforeModelCall: () => {}, // Task 10: budget gate
        onUsage: (id, usage) => {
          const costUsd = this.budget.addUsage(id, ref.model, usage);
          this.log.append('usage', { nodeId: id, ...usage, costUsd });
        },
        onTurnEnd: (id, finalText) => this.handleTurnEnd(id, finalText),
        onModelFailure: (id, error) => this.handleModelFailure(id, error),
        abortSignal: this.abort.signal,
      },
    );
    this.nodes.set(nodeId, node);
    return nodeId;
  }

  private delegate(fromNodeId: string, args: { role: string; charter: string; task: string; provider?: Provider; model?: string }): string {
    const parent = this.nodes.get(fromNodeId)!;
    const childDepth = parent.spec.depth + 1;
    if (childDepth > this.config.maxDepth) return 'refused: depth cap reached';
    const children = [...this.nodes.values()].filter(n => n.spec.parentId === fromNodeId);
    if (children.length >= this.config.maxChildren) return 'refused: max children reached';
    const live = [...this.nodes.values()].filter(n => !['completed', 'failed', 'canceled'].includes(this.taskStateOf(n.spec.taskId)));
    if (live.length >= this.config.maxConcurrentNodes) return 'refused: max concurrent nodes reached';

    const fallback = this.config.models.crew[children.length % this.config.models.crew.length];
    const ref = { provider: args.provider ?? fallback.provider, model: args.model ?? (args.provider ? this.config.models.crew.find(c => c.provider === args.provider)?.model ?? fallback.model : fallback.model) };
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
        if (resolved.to === 'operator') this.escalationCb?.({ taskId: resolved.taskId, from: resolved.from, text: resolved.text });
        else this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
      case 'ANSWER':
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

  private handleModelFailure(nodeId: string, error: string): void {
    const node = this.nodes.get(nodeId)!;
    this.log.append('task.state', { taskId: node.spec.taskId, state: 'failed' });
    this.route({ kind: 'ESCALATE', from: nodeId, to: node.spec.parentId, taskId: node.spec.taskId, text: `node failed after retry: ${error}` });
  }
}
```

`kernel/src/index.ts`:
```ts
export * from './types.js';
export { EventLog } from './log.js';
export { reduce, nodeState, type FleetState } from './reducer.js';
export { BudgetTracker, BudgetExceededError } from './budget.js';
export { realModelFactory, type ModelFactory } from './providers.js';
export { Mission, type MissionDeps, type MissionResult } from './kernel.js';
```

- [ ] **Step 4: Run tests — full suite**

Run: `npx vitest run`
Expected: all kernel tests pass, including the 3 new Mission tests. Debug routing with `mission.log.events` dumps if the completion promise hangs (vitest timeout = a routing bug: check that ESCALATE task-state transitions don't block the auto-deliver fallback: a task in `input-required` must NOT auto-deliver).

- [ ] **Step 5: Commit**

```bash
git add kernel/src/kernel.ts kernel/src/index.ts kernel/test/kernel.test.ts
git commit -m "feat(kernel): Mission orchestration — spawn, route, caps, completion"
```

---

### Task 10: Rails — budget refusal, watchdog, timeout, cancel

**Files:**
- Modify: `kernel/src/kernel.ts` (fill the two marked hooks + add timers)
- Test: `kernel/test/rails.test.ts`

**Interfaces:**
- Consumes: Task 9's Mission.
- Produces: enforced rails. `beforeModelCall` now calls `budget.assertUnderCap()`; a `BudgetExceededError` anywhere fails the mission (`mission.failed`, `reason: 'budget-exceeded'`). `start()` arms: watchdog interval (every 30s, any node whose task is `working` and whose `lastTs` in FleetState is older than `watchdogMs` triggers one `watchdog` event + auto-ESCALATE to operator, once per node) and a mission timeout (`missionTimeoutMs` → `cancel('mission timeout')`). `finish()` clears both timers (`clearInterval`/`clearTimeout`, plus `.unref()` on creation so the process can exit).
- Documented failure/recovery semantics (v0.1, deliberate): a node whose model call fails twice has its task marked `failed` and an ESCALATE routed to its parent; the ESCALATE transition makes the task `input-required`, so an ANSWER re-wakes the node — that answer is the retry path, and the wake also drains any messages stranded in the node's inbox by the failed turn. A failed node that never receives an ANSWER stays idle; every message to it is already in the event log, so nothing is lost from the record.
- Hardening: `AgentNode.enqueue`'s floating `runLoop()` promise gets a catch fence so a throwing kernel hook (`onUsage`/`onTurnEnd`) surfaces as a node failure instead of a process-level unhandledRejection.

- [ ] **Step 1: Write the failing tests**

`kernel/test/rails.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { scriptedModel } from './helpers.js';

describe('rails', () => {
  it('fails the mission when the budget cap is hit', async () => {
    // pricing that makes the first usage event blow the cap
    const cfg = { ...defaultConfig(), budgetUsd: 0.000001 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { text: 'awaiting' },
      { text: 'never reached' },
    ]);
    let first = true;
    const mission = new Mission('x', cfg, {
      modelFactory: () => (first ? ((first = false), captain) : scriptedModel([{ toolName: 'deliver', input: { text: 'r' } }, { text: '' }])),
    });
    const res = await mission.start();
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('budget-exceeded');
  });

  it('cancel() cancels a running mission', async () => {
    // a model that never finishes its "turn" — simulate with a long-hanging doGenerate
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({
      doGenerate: () => new Promise(() => {}),
    });
    const mission = new Mission('x', defaultConfig(), { modelFactory: () => hanging as any });
    const p = mission.start();
    setTimeout(() => mission.cancel('operator kill'), 30);
    const res = await p;
    expect(res.status).toBe('canceled');
    expect(res.reason).toBe('operator kill');
    expect(mission.state().status).toBe('canceled');
  });

  it('mission timeout cancels via fake timers', async () => {
    vi.useFakeTimers();
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({ doGenerate: () => new Promise(() => {}) });
    const cfg = { ...defaultConfig(), missionTimeoutMs: 60_000 };
    const mission = new Mission('x', cfg, { modelFactory: () => hanging as any });
    const p = mission.start();
    await vi.advanceTimersByTimeAsync(61_000);
    const res = await p;
    expect(res.status).toBe('canceled');
    expect(res.reason).toBe('mission timeout');
    vi.useRealTimers();
  });

  it('watchdog escalates a silent working node to the operator', async () => {
    vi.useFakeTimers();
    const { MockLanguageModelV2 } = await import('ai/test');
    const hanging = new MockLanguageModelV2({ doGenerate: () => new Promise(() => {}) });
    const cfg = { ...defaultConfig(), watchdogMs: 120_000, missionTimeoutMs: 10_000_000 };
    const mission = new Mission('x', cfg, { modelFactory: () => hanging as any });
    const seen: any[] = [];
    mission.onOperatorEscalation(e => seen.push(e));
    const p = mission.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(seen.length).toBe(1);
    expect(seen[0].text).toContain('watchdog');
    // watchdog escalations are answerable: the task pauses and an ANSWER resumes it
    expect(mission.state().tasks[seen[0].taskId].state).toBe('input-required');
    mission.answerEscalation(seen[0].taskId, 'keep going');
    expect(mission.state().tasks[seen[0].taskId].state).toBe('working');
    mission.cancel('cleanup');
    await p;
    vi.useRealTimers();
  });

  it('a refused delegate leaves a tool.called audit event', async () => {
    const cfg = { ...defaultConfig(), maxChildren: 0 };
    const captain = scriptedModel([
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { text: 'FINAL: no crew' },
    ]);
    const mission = new Mission('x', cfg, { modelFactory: () => captain });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    const audit = mission.log.events.filter(e => e.type === 'tool.called');
    expect(audit).toHaveLength(1);
    expect((audit[0].data as any).outcome).toBe('refused: max children reached');
  });

  it('ANSWER to an unknown or non-escalated task is ignored', async () => {
    const captain = scriptedModel([
      { toolName: 'escalate', input: { question: 'which scope?' } },
      { text: 'awaiting' },
      { text: 'FINAL: scoped' },
    ]);
    const mission = new Mission('x', defaultConfig(), { modelFactory: () => captain });
    mission.onOperatorEscalation(e => {
      mission.answerEscalation('t-phantom', 'lost');   // guard must drop this
      setTimeout(() => mission.answerEscalation(e.taskId, 'real answer'), 10);
    });
    const res = await mission.start();
    expect(res.status).toBe('completed');
    expect(mission.state().tasks['t-phantom']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run kernel/test/rails.test.ts`
Expected: FAIL — budget test returns completed instead of failed; timeout/watchdog tests hang then time out.

- [ ] **Step 3: Implement in `kernel/src/kernel.ts`**

Changes (exact):

1. Import `BudgetExceededError` from `./budget.js`.
2. Replace `beforeModelCall: () => {}` with:
```ts
beforeModelCall: () => this.budget.assertUnderCap(),
```
3. In `handleModelFailure`, detect the budget case before the generic path:
```ts
private handleModelFailure(nodeId: string, error: string): void {
  if (error.includes('BudgetExceededError')) {
    this.finish({ status: 'failed', reason: 'budget-exceeded', totalCostUsd: this.budget.totalUsd }, 'mission.failed', { reason: 'budget-exceeded' });
    return;
  }
  const node = this.nodes.get(nodeId)!;
  this.log.append('task.state', { taskId: node.spec.taskId, state: 'failed' });
  this.route({ kind: 'ESCALATE', from: nodeId, to: node.spec.parentId, taskId: node.spec.taskId, text: `node failed after retry: ${error}` });
}
```
4. Add fields + timer arming in `start()` (replace the Task 10 comment):
```ts
private timers: { watchdog?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {};
private watchdogFired = new Set<string>();
```
```ts
this.timers.timeout = setTimeout(() => this.cancel('mission timeout'), this.config.missionTimeoutMs);
this.timers.timeout.unref?.();
this.timers.watchdog = setInterval(() => this.checkWatchdog(), 30_000);
this.timers.watchdog.unref?.();
```
5. Add:
```ts
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
```
6. In `finish()`, first lines:
```ts
if (this.timers.watchdog) clearInterval(this.timers.watchdog);
if (this.timers.timeout) clearTimeout(this.timers.timeout);
```
7. In `kernel/src/node.ts`, replace the body of `enqueue` with:
```ts
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
```
(No behavior change for existing tests: `runLoop` still converts model/gate errors internally; the fence only catches hook throws.)
8. Guard the ANSWER route (Task 9 review): replace the `case 'ANSWER':` body in `route()` with:
```ts
      case 'ANSWER':
        // Only an input-required task can be answered; stale answers to closed
        // tasks and answers to unknown taskIds stay logged (message event above)
        // but are not acted on — this also keeps phantom tasks out of the state.
        if (this.taskStateOf(resolved.taskId) !== 'input-required') break;
        this.log.append('task.state', { taskId: resolved.taskId, state: 'working' });
        this.nodes.get(resolved.to)?.enqueue(resolved);
        break;
```
9. Fence the operator escalation callback everywhere it fires (route ESCALATE case + checkWatchdog):
```ts
        try { this.escalationCb?.({ taskId: resolved.taskId, from: resolved.from, text: resolved.text }); }
        catch { /* operator callback errors must not poison kernel routing */ }
```
10. Audit-log delegate outcomes: rename the existing `delegate()` body to `private tryDelegate(...)` (same signature) and add:
```ts
  private delegate(fromNodeId: string, args: { role: string; charter: string; task: string; provider?: Provider; model?: string }): string {
    const outcome = this.tryDelegate(fromNodeId, args);
    this.log.append('tool.called', { nodeId: fromNodeId, tool: 'delegate', role: args.role, outcome });
    return outcome;
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all tests pass, including all 4 rails tests and no regressions in Task 9's tests.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/kernel.ts kernel/test/rails.test.ts
git commit -m "feat(kernel): enforce budget cap, watchdog, timeout, cancel rails"
```

---

### Task 11: CLI — render + run + inline escalation replies

**Files:**
- Create: `cli/src/render.ts`, `cli/src/run.ts`, `cli/src/index.ts`
- Test: `cli/test/render.test.ts`

**Interfaces:**
- Consumes: `Mission`, `realModelFactory`, `defaultConfig`, `FleetEvent` from `@flota/kernel`.
- Produces:
  - `formatEvent(e: FleetEvent): string | null` — one colored line per event; returns `null` for events not shown (`tool.called`, `task.state`). Format (picocolors; plain text shown here):
    ```
    12:04:11 ▸ mission m-xyz started: survey fairness metrics
    12:04:12 + captain spawned (anthropic/claude-sonnet-4-5)
    12:04:19 + metrics-scan-2 spawned (openai/gpt-5.1) ← captain
    12:04:19 → ORDER    captain → metrics-scan-2 (t2): scan metrics…
    12:04:40 ← REPORT   metrics-scan-2 (t2): found 8 so far
    12:04:52 ⚠ ESCALATE metrics-scan-2 (t2): include non-ICU?
    12:05:20 ✓ DELIVER  metrics-scan-2 (t2): [512 chars]
    12:05:40 $ usage    captain +$0.0210
    12:06:02 ■ mission completed ($0.87)
    ```
    Message texts truncate at 100 chars with `…`; DELIVER shows `[N chars]` instead of the text.
  - `flota run "<order>" [--budget <usd>] [--missions-dir <path>]` — builds config (`defaultConfig()` + overrides), verifies the needed `*_API_KEY` env vars exist (exit 1 with a clear message if not), starts the Mission, subscribes `formatEvent` lines to stdout, and on operator escalation prints the question and reads one line from stdin (`node:readline/promises`) → `mission.answerEscalation`. On completion prints the result text and cost summary; exit code 0 for completed, 1 otherwise.

- [ ] **Step 1: Write the failing test**

`cli/test/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatEvent } from '../src/render.js';
import type { FleetEvent } from '@flota/kernel';

const ev = (type: string, data: Record<string, unknown>): FleetEvent =>
  ({ eventId: 'e', seq: 1, ts: '2026-07-13T12:04:11.000Z', missionId: 'm-x', type: type as any, data });

describe('formatEvent', () => {
  it('renders spawn, message, usage, terminal events; hides task.state and tool.called', () => {
    expect(formatEvent(ev('node.spawned', { nodeId: 'captain', role: 'captain', provider: 'anthropic', model: 'claude-sonnet-4-5' })))
      .toContain('captain spawned (anthropic/claude-sonnet-4-5)');
    expect(formatEvent(ev('message', { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'include non-ICU?' })))
      .toContain('ESCALATE');
    expect(formatEvent(ev('usage', { nodeId: 'captain', costUsd: 0.021 }))).toContain('+$0.0210');
    expect(formatEvent(ev('mission.completed', { result: 'x' }))).toContain('completed');
    expect(formatEvent(ev('task.state', { taskId: 't1', state: 'working' }))).toBeNull();
    expect(formatEvent(ev('tool.called', {}))).toBeNull();
  });

  it('truncates long message text at 100 chars and hides DELIVER bodies', () => {
    const long = 'y'.repeat(300);
    const line = formatEvent(ev('message', { kind: 'REPORT', from: 'a', to: 'b', taskId: 't', text: long }))!;
    expect(line.length).toBeLessThan(220);
    expect(line).toContain('…');
    const del = formatEvent(ev('message', { kind: 'DELIVER', from: 'a', to: 'b', taskId: 't', text: long }))!;
    expect(del).toContain('[300 chars]');
    expect(del).not.toContain('yyyy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/test/render.test.ts`
Expected: FAIL — cannot resolve `../src/render.js`.

- [ ] **Step 3: Implement**

`cli/src/render.ts`:
```ts
import pc from 'picocolors';
import type { FleetEvent } from '@flota/kernel';

const KIND_ICON: Record<string, string> = { ORDER: '→', REPORT: '←', DELIVER: '✓', ESCALATE: '⚠', ANSWER: '↩' };

function clock(ts: string): string { return pc.dim(ts.slice(11, 19)); }
function trunc(s: string): string { return s.length > 100 ? s.slice(0, 100) + '…' : s; }

export function formatEvent(e: FleetEvent): string | null {
  const d = e.data as any;
  switch (e.type) {
    case 'mission.started': return `${clock(e.ts)} ${pc.bold('▸')} mission ${e.missionId} started: ${d.order}`;
    case 'node.spawned': {
      const from = d.parentId ? ` ${pc.dim('← ' + d.parentId)}` : '';
      return `${clock(e.ts)} ${pc.green('+')} ${pc.bold(d.nodeId)} spawned (${d.provider}/${d.model})${from}`;
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
```

`cli/src/run.ts`:
```ts
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { Mission, defaultConfig, realModelFactory } from '@flota/kernel';
import { formatEvent } from './render.js';

export async function runMission(order: string, opts: { budget?: string; missionsDir?: string }): Promise<number> {
  const config = defaultConfig();
  if (opts.budget !== undefined) {
    const cap = Number(opts.budget);
    // WHY the isFinite gate: Number('abc') is NaN, and `total >= NaN` is always
    // false — an unvalidated --budget would silently disable the hard cap.
    if (!Number.isFinite(cap) || cap <= 0) {
      console.error(pc.red(`--budget must be a positive number, got '${opts.budget}'`));
      return 1;
    }
    config.budgetUsd = cap;
  }

  const providersUsed = new Set([config.models.captain.provider, ...config.models.crew.map(c => c.provider)]);
  for (const p of providersUsed) {
    const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (!process.env[key]) { console.error(pc.red(`missing ${key} in environment`)); return 1; }
  }

  const missionsDir = opts.missionsDir ?? './missions';
  const mission = new Mission(order, config, { modelFactory: realModelFactory, missionsDir });
  mission.log.subscribe(e => { const line = formatEvent(e); if (line) console.log(line); });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // WHY the queue: readline drops a second question() registered while one is
  // pending — concurrent escalations would silently lose every answer but the
  // first. Serializing through a promise chain guarantees each gets its turn.
  let promptChain: Promise<void> = Promise.resolve();
  mission.onOperatorEscalation((e) => {
    promptChain = promptChain.then(async () => {
      try {
        const answer = await rl.question(pc.yellow(`\n⚠ ${e.from} asks: ${e.text}\nyour answer> `));
        mission.answerEscalation(e.taskId, answer);
      } catch { /* readline closed mid-question (mission ended) — nothing left to answer */ }
    });
  });
  // WHY both hooks: on a TTY, readline owns stdin and delivers Ctrl-C as an
  // rl 'SIGINT' event, not a process signal; the process hook still covers
  // non-TTY stdin and external `kill -INT`.
  rl.on('SIGINT', () => mission.cancel('operator kill (Ctrl-C)'));
  process.on('SIGINT', () => mission.cancel('operator kill (SIGINT)'));

  const result = await mission.start();
  rl.close();
  if (result.status === 'completed') {
    console.log('\n' + pc.bold('── DELIVERABLE ──────────────────────'));
    console.log(result.result);
    console.log(pc.dim(`\ntotal cost: $${result.totalCostUsd.toFixed(2)} · log: ${missionsDir}/${mission.id}/events.jsonl`));
    return 0;
  }
  console.error(pc.red(`mission ${result.status}: ${result.reason ?? ''} (spent $${result.totalCostUsd.toFixed(2)})`));
  return 1;
}
```

`cli/src/index.ts`:
```ts
#!/usr/bin/env tsx
import { Command } from 'commander';
import { runMission } from './run.js';
import { replay } from './replay.js';

const program = new Command('flota');
program.command('run <order>')
  .description('run a mission: a captain decomposes your order across crew agents')
  .option('--budget <usd>', 'hard mission budget cap in USD')
  .option('--missions-dir <path>', 'where mission logs/workspaces live')
  .action(async (order, opts) => { process.exitCode = await runMission(order, opts); });
program.command('replay <eventsFile>')
  .description('re-render a past mission log; --step to advance per keypress')
  .option('--step', 'wait for Enter between events')
  .action(async (file, opts) => { await replay(file, opts); });
program.parseAsync();
```

(`replay.ts` arrives in Task 12 — create a stub `export async function replay() {}` now so `index.ts` compiles, and note Task 12 replaces it.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run cli/test/render.test.ts && npm run typecheck`
Expected: 2 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/test/render.test.ts
git commit -m "feat(cli): run command with live line-tail and inline escalation replies"
```

---

### Task 12: CLI replay stepper

**Files:**
- Modify: `cli/src/replay.ts` (replace stub)
- Test: `cli/test/replay.test.ts`

**Interfaces:**
- Consumes: `EventLog.load`, `formatEvent`.
- Produces: `replay(eventsFile: string, opts: { step?: boolean }, out?: (line: string) => void): Promise<void>` — loads the JSONL, renders every visible event through `formatEvent` to `out` (default `console.log`); with `--step`, waits for Enter between events (skipped when `out` is provided, so tests run non-interactively).

- [ ] **Step 1: Write the failing test**

`cli/test/replay.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay } from '../src/replay.js';

describe('replay', () => {
  it('re-renders a persisted mission log in order', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-replay-')), 'events.jsonl');
    const events = [
      { eventId: 'a', seq: 1, ts: '2026-07-13T12:00:00.000Z', missionId: 'm-1', type: 'mission.started', data: { order: 'scan' } },
      { eventId: 'b', seq: 2, ts: '2026-07-13T12:00:01.000Z', missionId: 'm-1', type: 'task.state', data: { taskId: 't1', state: 'working' } },
      { eventId: 'c', seq: 3, ts: '2026-07-13T12:00:05.000Z', missionId: 'm-1', type: 'mission.completed', data: { result: 'ok' } },
    ];
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const lines: string[] = [];
    await replay(file, {}, l => lines.push(l));
    expect(lines).toHaveLength(2); // task.state hidden
    expect(lines[0]).toContain('mission m-1 started');
    expect(lines[1]).toContain('completed');
  });

  it('renders a marker line for shape-malformed records instead of crashing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flota-replay-')), 'events.jsonl');
    const events = [
      { eventId: 'a', seq: 1, ts: '2026-07-13T12:00:00.000Z', missionId: 'm-1', type: 'mission.started', data: { order: 'scan' } },
      // a message event missing data.text — formatEvent throws on d.text.length
      { eventId: 'b', seq: 2, ts: '2026-07-13T12:00:01.000Z', missionId: 'm-1', type: 'message', data: { kind: 'REPORT', from: 'a', to: 'b', taskId: 't' } },
    ];
    writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const lines: string[] = [];
    await replay(file, {}, l => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('malformed event (seq 2)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/test/replay.test.ts`
Expected: FAIL — stub renders nothing.

- [ ] **Step 3: Implement**

`cli/src/replay.ts`:
```ts
import { createInterface } from 'node:readline/promises';
import { EventLog } from '@flota/kernel';
import { formatEvent } from './render.js';

export async function replay(eventsFile: string, opts: { step?: boolean }, out?: (line: string) => void): Promise<void> {
  const events = EventLog.load(eventsFile);
  const print = out ?? console.log;
  const rl = opts.step && !out ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  for (const e of events) {
    // WHY the try/catch: replay feeds formatEvent arbitrary events.jsonl content
    // (hand-edited or truncated files); one malformed record must not kill the replay.
    let line: string | null;
    try { line = formatEvent(e); }
    catch { line = `⚠ malformed event (seq ${(e as { seq?: number }).seq ?? '?'})`; }
    if (!line) continue;
    print(line);
    if (rl) await rl.question('');
  }
  rl?.close();
}
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: everything passes across both workspaces.

- [ ] **Step 5: Commit**

```bash
git add cli/src/replay.ts cli/test/replay.test.ts
git commit -m "feat(cli): replay stepper over persisted mission logs"
```

---

### Task 13: Live demo mission + README quickstart (manual verification)

**Files:**
- Modify: `README.md` (add Quickstart section)
- No new tests — this task is the spec's demo-mission verification with real APIs.

**Interfaces:**
- Consumes: the finished CLI.
- Produces: evidence the vertical slice works end-to-end, and user-facing docs.

- [ ] **Step 1: Verify current model ids and pricing**

Check the model ids and per-MTok prices in `defaultConfig()` (`kernel/src/types.ts`) against the providers' current documentation (Anthropic: platform.claude.com/docs; OpenAI: developers.openai.com/api/docs/pricing). Update ids/prices if drifted. Commit any change as `chore: refresh default model ids/pricing`.

- [ ] **Step 2: Run the demo mission (small budget)**

```bash
export ANTHROPIC_API_KEY=…  OPENAI_API_KEY=…
npx tsx cli/src/index.ts run "Survey the fairness metrics most commonly used to evaluate ICU mortality-risk prediction models. Delegate scanning and critique to separate crew, then deliver a structured brief." --budget 2
```

Expected observations (all four must hold):
1. Line-tail shows captain spawn, ≥2 crew spawns **on both providers** (`anthropic/…` and `openai/…` lines), ORDER/REPORT/DELIVER flow, usage lines with nonzero `$`.
2. A `── DELIVERABLE ──` brief prints; exit code 0.
3. `missions/<id>/events.jsonl` exists; `npx tsx cli/src/index.ts replay missions/<id>/events.jsonl` re-renders the run.
4. Total cost printed ≤ $2.

If the captain never delegates: strengthen nothing silently — check the transcript in `events.jsonl` first, then adjust `CAPTAIN_CHARTER` wording in `kernel/src/kernel.ts` if the instruction is being ignored, and re-run.

- [ ] **Step 3: Add Quickstart to README**

Append after the "Why it doesn't already exist" section:
```markdown
## Quickstart (v0.1)

```bash
npm install
export ANTHROPIC_API_KEY=sk-… OPENAI_API_KEY=sk-…
npx tsx cli/src/index.ts run "your mission order here" --budget 2
# re-watch any past mission:
npx tsx cli/src/index.ts replay missions/<mission-id>/events.jsonl
```

Every mission writes an append-only event log to `missions/<id>/events.jsonl` and a
sandboxed crew workspace to `missions/<id>/workspace/`. Hard budget cap, depth cap,
watchdog, and kill switch (Ctrl-C) are kernel-enforced.
```

- [ ] **Step 4: Full suite + typecheck one last time**

Run: `npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add README.md kernel/src/types.ts
git commit -m "docs: quickstart; verify live demo mission on two providers"
```

---

---

# Phase 2 — Subscription pivot (approved 2026-07-14)

> Operator decision: v0.1's demo runs on subscription CLIs (Claude Code on the Claude sub, Codex on the OpenAI sub), not API keys. The `api` driver stays fully supported for open-source users. Spec §3.1/§4/§5 amended same day. Tasks P1–P6 below replace the original Task 13 Step 2 (live API demo).

**Phase-2 Global Constraints (in addition to the originals):**
- `TurnDriver` is the single seam: `turn(input: TurnInput): Promise<TurnOutput>`. AgentNode/kernel never know which runtime produced a turn.
- CLI drivers are tested against **stub binaries** (shell scripts passed via `bin` option) — tests never invoke the real `claude`/`codex` or any subscription.
- Coordination from CLI nodes travels as one fenced ` ```flota ` JSON block: `{"commands":[...]}` — parsed by `parseCommands`, executed against the SAME coordination ToolSet. Command results are queued by the driver and prefixed to the node's next turn.
- Subscription turns report `billing: 'subscription'`; kernel logs their usage with `costUsd: 0` (never run subscription usage through the pricing table — the max-rate fallback would false-trip the cap). `$` cap continues to bite for `billing: 'api'`.
- New rail: `maxTurnsPerNode` (default 20), kernel-enforced in `beforeModelCall` via per-node counters → existing retry-then-escalate machinery.
- `watchdogMs` default becomes 600_000 (CLI turns are slow).
- If the installed `claude`/`codex` CLI's flags differ from the plan's invocation, adapt the arg-builder functions only — never the driver's TurnDriver contract or the tests' observable behavior (stub binaries pin the contract).

### Task P1: TurnDriver seam + AiSdkDriver refactor

**Files:**
- Create: `kernel/src/driver.ts`
- Modify: `kernel/src/types.ts` (NodeRef/DriverKind, config shape), `kernel/src/node.ts` (driver instead of model), `kernel/src/kernel.ts` (driverFactory, ref resolution, billing-aware usage), `kernel/src/tools/coordination.ts` (delegate schema: driver enum), `kernel/src/providers.ts` (keep realModelFactory; export type DriverFactory), `kernel/src/index.ts` (exports), `cli/src/run.ts` (api-key gate only for api refs; temporary factory), and all affected tests (`node.test.ts`, `kernel.test.ts`, `rails.test.ts`, `coordination.test.ts`)
- Test: assertions updated in place; no new test file

**Interfaces:**
- Produces (exact):
  ```ts
  // types.ts additions/changes
  export type DriverKind = 'api' | 'claude-code' | 'codex';
  export interface NodeRef { driver: DriverKind; provider?: Provider; model?: string }
  // MissionConfig.models becomes:
  //   models: { captain: NodeRef; crew: NodeRef[]; apiDefaults: Record<Provider, string> }
  // defaultConfig(): captain { driver: 'claude-code' }, crew [{ driver: 'claude-code' }, { driver: 'codex' }],
  //   apiDefaults { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-sol' }; watchdogMs: 600_000; maxTurnsPerNode: 20 (field added; enforcement lands in P5)

  // driver.ts
  export interface TurnInput {
    system: string;
    newText: string;                    // this turn's incoming batch, formatted
    transcript: ModelMessage[];         // full history incl. the new user message (api driver)
    tools: ToolSet;
    maxSteps: number;
    abortSignal: AbortSignal;
  }
  export interface TurnOutput {
    text: string;
    responseMessages: ModelMessage[];   // [] for CLI drivers
    usage: { inputTokens: number; outputTokens: number };
    billing: 'api' | 'subscription';
  }
  export interface TurnDriver { turn(input: TurnInput): Promise<TurnOutput> }
  export class AiSdkDriver implements TurnDriver { constructor(model: LanguageModel) }

  // providers.ts
  export type DriverFactory = (ref: NodeRef, ctx: { workspaceDir: string }) => TurnDriver;

  // kernel.ts
  export interface MissionDeps { driverFactory: DriverFactory; missionsDir?: string }
  // NodeDeps.onUsage gains billing: onUsage(nodeId, usage, billing)
  ```
- Delegate ref resolution in `kernel.delegate` (exact):
  ```ts
  const fallback = this.config.models.crew[children.length % this.config.models.crew.length];
  const ref: NodeRef = (args.driver || args.provider)
    ? {
        driver: args.driver ?? 'api',
        provider: args.provider,
        model: args.model ?? (args.provider ? this.config.models.apiDefaults[args.provider] : undefined),
      }
    : fallback;
  ```
- `AiSdkDriver.turn` body = today's `generateText` call verbatim, returning `{ text, responseMessages: result.response.messages, usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 }, billing: 'api' }`.
- `AgentNode.runLoop` change: `const result = await this.callDriverWithRetry(text)` where `callDriverWithRetry` calls `this.deps.driver.turn({ system: this.spec.charter, newText: text, transcript: this.transcript, tools: this.deps.tools, maxSteps: this.deps.maxStepsPerTurn, abortSignal: this.deps.abortSignal })` with the same 2-attempt/abort/failure semantics as before; then `this.transcript.push(...result.responseMessages); this.deps.onUsage(this.spec.id, result.usage, result.billing); this.deps.onTurnEnd(this.spec.id, result.text);`.
- Kernel `onUsage` closure (exact):
  ```ts
  onUsage: (id, usage, billing) => {
    const modelId = ref.model ?? (ref.provider ? this.config.models.apiDefaults[ref.provider] : 'unknown');
    const costUsd = billing === 'api' ? this.budget.addUsage(id, modelId, usage) : 0;
    this.log.append('usage', { nodeId: id, ...usage, costUsd, billing });
  },
  ```
- Coordination delegate schema replaces the provider enum with:
  ```ts
  driver: z.enum(['api', 'claude-code', 'codex']).optional().describe('runtime for this crew agent; omit for mission default'),
  provider: z.enum(['anthropic', 'openai']).optional().describe('api driver only'),
  model: z.string().optional(),
  ```
- Test sweep (mechanical, complete list): every `modelFactory: () => X` becomes `driverFactory: () => new AiSdkDriver(X)`; node tests build deps with `driver: new AiSdkDriver(model)`; the kernel happy-path provider assertion becomes — captured refs `[{driver:'claude-code'}, {driver:'api',provider:'anthropic',model:'claude-sonnet-5'}, {driver:'api',provider:'openai',model:'gpt-5.6-sol'}]` — assert `refs.map(r => r.driver)` equals `['claude-code','api','api']` and `refs.slice(1).map(r => r.provider)` equals `['anthropic','openai']`. `cli/src/run.ts`: build a temporary factory `const driverFactory: DriverFactory = (ref) => { if (ref.driver !== 'api') throw new Error(\`driver not implemented yet: ${ref.driver} (P3/P4)\`); return new AiSdkDriver(realModelFactory({ provider: ref.provider ?? 'anthropic', model: ref.model ?? config.models.apiDefaults[ref.provider ?? 'anthropic'] })); }` and gate env keys only over refs with `driver === 'api'` (with the pivoted defaults that set is empty — the run command still compiles and runs for api configs).

Steps: update types → driver.ts + failing-compile sweep → run full suite → all 35 must pass again → commit `refactor(kernel): TurnDriver seam; subscription-first default config`.

**P1 post-review addendum (fix lands with P2 as its own commit):** `node.spawned` must carry the runtime identity for CLI-driver nodes. Exact changes: (1) `kernel.ts` `spawn()` logs `driver: ref.driver` alongside the now-optional provider/model; (2) `reducer.ts` `NodeView` widens to `provider?: string; model?: string` and gains `driver?: string` (populated from the event); (3) `render.ts` node.spawned line becomes
```ts
const runtime = d.provider ? `${d.provider}/${d.model}` : String(d.driver ?? 'unknown');
return `${clock(e.ts)} ${pc.green('+')} ${pc.bold(d.nodeId)} spawned (${runtime})${from}`;
```
(4) render test gains: `expect(formatEvent(ev('node.spawned', { nodeId: 'crew-2', driver: 'codex' })))).toContain('crew-2 spawned (codex)')`; (5) kernel happy-path test adds `expect(refs.slice(1).map(r => r.model)).toEqual(['claude-sonnet-5', 'gpt-5.6-sol']);` to pin the apiDefaults lookup. Commit: `fix(kernel): spawn events carry driver identity; render CLI runtimes`.

### Task P2: JSON command protocol

**Files:**
- Create: `kernel/src/protocol.ts`
- Test: `kernel/test/protocol.test.ts`

**Interfaces (exact):**
```ts
export type Command =
  | { cmd: 'delegate'; role: string; charter: string; task: string; driver?: DriverKind }
  | { cmd: 'report'; text: string }
  | { cmd: 'deliver'; text: string }
  | { cmd: 'escalate'; question: string }
  | { cmd: 'answer'; taskId: string; text: string };
export function parseCommands(text: string): { commands: Command[]; cleanText: string };
export async function executeCommands(commands: Command[], tools: ToolSet): Promise<string[]>;
export const PROTOCOL_INSTRUCTIONS: string;
```
Behavior to pin with tests: (1) extracts the LAST fenced block labeled `flota` containing `{"commands":[...]}`, removes it from cleanText, returns typed commands; (2) invalid JSON / no block / unlabeled block → `{ commands: [], cleanText: text }`; (3) `executeCommands` maps cmd→tool name (delegate/report/deliver/escalate/answer), calls `tool.execute(argsWithoutCmd, { toolCallId: 'proto', messages: [] })`, collects `"<cmd> → <result>"` strings; unknown cmd or missing tool → `"<cmd> → error: unknown command"`; a throwing execute → `"<cmd> → error: <message>"` (never rejects). (4) `PROTOCOL_INSTRUCTIONS` teaches the fenced-block format and mandates ending with a `deliver` command when the task is done. TDD, commit `feat(kernel): fenced JSON command protocol for CLI-driver nodes`.

### Task P3: ClaudeCodeDriver

**Files:**
- Create: `kernel/src/drivers/claudeCode.ts`, `kernel/test/fixtures/fake-claude.sh` (chmod +x)
- Test: `kernel/test/claudeCode.test.ts`

**Contract:** `new ClaudeCodeDriver({ workspaceDir, bin?, timeoutMs? })` implements TurnDriver.
- First turn args: `['-p', promptText, '--output-format', 'json', '--append-system-prompt', system + '\n\n' + PROTOCOL_INSTRUCTIONS, '--allowedTools', 'Read,Write,Edit,Glob,Grep']`; later turns replace the system flag with `['--resume', sessionId]`. `promptText` = pending command results (if any, under a `[command results]` header) + newText. Spawn via `execFile(bin ?? 'claude', args, { cwd: workspaceDir, signal, timeout: timeoutMs ?? 600_000, maxBuffer: 10 * 2 ** 20 })`.
- Parse stdout as JSON: `{ result, session_id, usage: { input_tokens, output_tokens } }` (fields defensive-defaulted). Store `session_id`. `parseCommands(result)` → `executeCommands(...)` → queue result strings for next turn. Return `{ text: cleanText, responseMessages: [], usage, billing: 'subscription' }`. Unparseable stdout → throw (node retry-then-escalate handles it).
- Stub binary `fake-claude.sh`: appends its argv as one JSON line to the file named by env `FAKE_CLI_LOG`, then prints a canned JSON payload selected by env `FAKE_CLI_REPLY` (allows scripting two-turn tests). Tests pin: first-turn args include `--append-system-prompt` (with PROTOCOL_INSTRUCTIONS) and NOT `--resume`; second turn includes `--resume <session_id from first reply>`; a reply whose `result` carries a ` ```flota ` deliver block causes the deliver tool to fire (fake ToolSet records calls) and the block is stripped from returned text; command results from turn 1 appear in turn 2's prompt under `[command results]`.
Commit `feat(kernel): ClaudeCodeDriver — headless claude -p on subscription auth`.

### Task P4: CodexDriver

**Files:**
- Create: `kernel/src/drivers/codex.ts`, `kernel/test/fixtures/fake-codex.sh`
- Test: `kernel/test/codex.test.ts`

Same shape as P3 with codex specifics: first turn `['exec', promptText, '--json', '--cd', workspaceDir, '--sandbox', 'workspace-write']`; later turns `['exec', 'resume', sessionId, promptText, '--json', '--cd', workspaceDir, '--sandbox', 'workspace-write']`. Stdout is JSONL events: collect `session_id`/`thread_id` from the first event carrying one; final text = concatenation of events with `type` containing `agent_message` (fallback: last line's `text` field; final fallback: raw stdout). System prompt + PROTOCOL_INSTRUCTIONS prefix the FIRST turn's promptText under a `[role charter]` header (codex exec has no system-prompt flag). Same command-execution/pending-results queue as P3 (extract the shared logic into a small `runProtocol(text, tools, pending)` helper in `protocol.ts` if duplication exceeds ~10 lines — allowed, flag in report). Arg-builders isolated as `firstArgs()`/`resumeArgs()` for cheap adaptation if the installed CLI's syntax differs (verify with `codex exec --help` during implementation; adapt builders only). Stub-tested identically. Commit `feat(kernel): CodexDriver — codex exec on subscription auth`.

### Task P5: Wiring — realDriverFactory, preflight, turn-cap rail, README

**Files:**
- Modify: `kernel/src/providers.ts` (realDriverFactory), `kernel/src/kernel.ts` (turn-cap in beforeModelCall), `kernel/src/index.ts`, `cli/src/run.ts` (preflight replaces temp factory), `README.md`
- Test: `kernel/test/rails.test.ts` (turn-cap test), `cli/test/` untouched

1. `realDriverFactory` (exact):
```ts
export const realDriverFactory: DriverFactory = (ref, ctx) => {
  if (ref.driver === 'claude-code') return new ClaudeCodeDriver({ workspaceDir: ctx.workspaceDir });
  if (ref.driver === 'codex') return new CodexDriver({ workspaceDir: ctx.workspaceDir });
  const provider = ref.provider ?? 'anthropic';
  return new AiSdkDriver(realModelFactory({ provider, model: ref.model ?? 'unset' }));
};
```
(run.ts resolves api model ids from `config.models.apiDefaults` before refs reach the factory — kernel's delegate resolution already does; captain ref from config must carry its model when api.)
2. Turn cap: kernel keeps `private turnCounts = new Map<string, number>()`; `beforeModelCall` closure becomes:
```ts
beforeModelCall: () => {
  const n = (this.turnCounts.get(nodeId) ?? 0) + 1;
  this.turnCounts.set(nodeId, n);
  if (n > this.config.maxTurnsPerNode) throw new Error(`TurnCapError: ${nodeId} exceeded ${this.config.maxTurnsPerNode} turns`);
  this.budget.assertUnderCap();
},
```
Rails test: config `maxTurnsPerNode: 0` → captain's first call fails twice → escalates to operator (assert the operator escalation text contains 'TurnCapError').
3. run.ts preflight: for kinds used in config — `api` → env-key gate (as now); `claude-code` → `execFile('claude', ['--version'])`; `codex` → `execFile('codex', ['--version'])`; failure → clear stderr line + exit 1.
4. README Quickstart rewritten subscription-first:
```markdown
## Quickstart (v0.1)

Flota's default config rides the agent CLIs you already have:
[Claude Code](https://claude.com/claude-code) (`claude`) and OpenAI's Codex CLI
(`codex`), each signed in on its own subscription — no API keys, $0 marginal.

```bash
npm install
npx tsx cli/src/index.ts run "your mission order here"
# re-watch any past mission:
npx tsx cli/src/index.ts replay missions/<mission-id>/events.jsonl
```

Prefer raw APIs? Point the config at the `api` driver and export
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; the hard dollar cap applies there
(`--budget`, default $5). Subscription nodes are bounded by per-node turn
caps, depth caps, a watchdog, and mission timeouts instead.
```
Full suite + typecheck; commit `feat: subscription-first wiring — driver factory, preflight, turn cap`.

### Task P6: Live subscription demo (replaces original Task 13 Step 2)

Preconditions: `claude --version` and `codex --version` both succeed and are signed in (subscription auth). NO API keys required or read.
1. Run: `npx tsx cli/src/index.ts run "Survey the fairness metrics most commonly used to evaluate ICU mortality-risk prediction models. Delegate scanning and critique to separate crew, then deliver a structured brief."`
2. Acceptance (all four): (a) line-tail shows captain on `claude-code` and ≥1 crew on `codex` (spawn lines name the driver — add driver to the `node.spawned` render if absent: `+ crew-2 spawned (codex)`); (b) `── DELIVERABLE ──` brief prints, exit 0; (c) `missions/<id>/events.jsonl` exists and `replay` re-renders it; (d) usage events show `billing: subscription`, cost ticker stays $0.00. If a watchdog escalation fires mid-run (CLI turns are slow), answer it (`keep going`) — that path is by design.
3. If the captain ignores the JSON protocol (no commands in output): inspect `events.jsonl`, tighten `PROTOCOL_INSTRUCTIONS` wording once, re-run once. Two protocol failures → BLOCKED with the transcript evidence.
4. Ledger + commit `docs: live subscription demo verified` (include the mission id + cost line in the commit body).

## Self-Review (completed inline)

1. **Spec coverage:** kernel ✓ (T2–T10), 2 providers ✓ (T5, T13), captain+crew depth-2 ✓ (T9), 4+ANSWER message kinds ✓ (T7/T9), JSONL log + reducer ✓ (T2–T3), CLI order entry/line-tail/inline replies ✓ (T11), replay stepper ✓ (T12), sandboxed file I/O ✓ (T6), all §4 rails ✓ (T9 caps, T10 budget/watchdog/timeout/cancel, T8 retry-then-escalate), demo mission ✓ (T13). Observatory app: explicitly out — separate plan. Gap check: none found.
2. **Placeholder scan:** the single stub (`replay.ts` in T11) is explicitly created and replaced by T12 — intentional compile bridge, not a placeholder.
3. **Type consistency:** `KernelApi.delegate(fromNodeId, args) → string` consistent T7↔T9; `NodeDeps` hooks consistent T8↔T9/T10; `FleetEvent`/`formatEvent` consistent T2↔T11/T12; `MissionResult` consistent T9↔T11.
