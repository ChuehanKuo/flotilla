# Flota v0.4 — Animated Observatory (Tauri desktop app)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** The flagship visual from day one — a persistent native desktop app that renders the fleet as a **live animated graph**: nodes colored by state, messages animating along edges as they route, a per-node inspector. Reads the same `events.jsonl` the kernel already writes; derives the graph via the kernel's own `reduce()` so it always matches reality.

**Architecture:** Vite + React + React Flow frontend (the animated canvas) → wrapped in a Tauri (Rust) native shell that file-watches `missions/<id>/events.jsonl` and streams events to the webview. The frontend imports `@flota/kernel`'s `reduce()`/`FleetState` so graph state == kernel state. Read-only first (visualize); steering (inject from the app) is a deferred follow-up (v0.4.1).

**Tech stack:** existing + `react@^18`, `react-dom`, `@xyflow/react` (React Flow v12), `@dagrejs/dagre` (tree layout), `vite`, `@vitejs/plugin-react`, `typescript`; Tauri v2 (`@tauri-apps/cli`, `@tauri-apps/api`, Rust). Rust toolchain installed separately.

## Global Constraints
- The observatory reads state ONLY by folding events via `@flota/kernel`'s `reduce()` (import it — do NOT reimplement fleet-state logic). Graph nodes/edges are a pure projection of `FleetState` + the event stream.
- Read-only in v0.4: the app visualizes; it never mutates a mission. (Inject/steer = v0.4.1, needs write-back to the live kernel.)
- No browser as the product: the shipped artifact is the Tauri app. Dev preview via Vite in a browser is dev-only and acceptable.
- Frontend logic (event→graph projection, layout, animation triggers) lives in pure/tested functions where practical; React Flow components are the thin render layer (mirror the TUI's pure-layer discipline).
- Tests never require the Tauri/Rust build to run (frontend logic tested via vitest + jsdom; the Rust shell is smoke-verified live).
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (new)
```
observatory/
  package.json            # @flota/observatory, deps above
  vite.config.ts
  index.html
  src/graph.ts            # pure: FleetState + events -> {nodes, edges} (React Flow), dagre layout, message-animation triggers
  src/App.tsx             # React Flow canvas + inspector, subscribes to an event source
  src/eventSource.ts      # abstraction: replay-from-file | live-stream; dev uses a WS/HTTP bridge, Tauri uses its event API
  src/main.tsx
  observatory/test/graph.test.ts
  src-tauri/              # (O3) Tauri Rust shell: file-watch missions/, emit events to webview
```

---

### Task O1: Animated fleet graph from a real event log (the core visual, shell-agnostic)

**Files:** scaffold `observatory/` (Vite+React+React Flow, add to root workspaces + vitest projects); `observatory/src/graph.ts`, `App.tsx`, `main.tsx`, `index.html`; `observatory/test/graph.test.ts`.

**graph.ts (pure, exact):**
```ts
import type { FleetEvent, FleetState } from '@flota/kernel';
export interface GraphNode { id: string; label: string; driver: string; state: string; costUsd: number; depth: number; isCaptain: boolean }
export interface GraphEdge { id: string; source: string; target: string; kind?: string; animating: boolean }
// project a FleetState (folded from events[0..cursor]) into graph nodes+edges;
// `recentMessage` (the event at the cursor, if a `message`) marks the edge it traveled as animating.
export function projectGraph(state: FleetState, recentMessage?: FleetEvent): { nodes: GraphNode[]; edges: GraphEdge[] };
export function layout(nodes: GraphNode[], edges: GraphEdge[]): { nodes: (GraphNode & {x:number;y:number})[]; edges: GraphEdge[] };  // dagre top-down tree
```
Message→edge mapping: an ORDER/REPORT/DELIVER/INSTRUCT between from→to marks the (from,to) or (to,from) parent-child edge as `animating` for that render tick.

**App.tsx:** React Flow (`@xyflow/react`) canvas; custom node component (colored by state: submitted=grey, working=blue/pulsing, input-required=amber, completed=green, failed=red; driver badge; cost). Animated edges (React Flow `animated` prop) when `animating`. Click node → side inspector showing that node's message/usage feed (reuse the TUI's `nodeFeed` idea or a local equivalent). A timeline scrubber/play control that advances a cursor over a loaded `events.jsonl` (REPLAY mode) so the fleet animates over time — this is what proves "animated" with real data before any live wiring.

**Dev preview:** `vite` dev server loads a real completed mission's `events.jsonl` (bundle one, or a file picker / `?log=` param) and plays it back — nodes appear as spawned, states transition, edges pulse as messages route. Document the exact `npm run dev -w observatory` command + how to point it at a log.

- [ ] TDD `graph.test.ts`: build a FleetState by `reduce()`-ing a synthetic event list; assert `projectGraph` yields the right nodes (captain + crew, depth, isCaptain, state colors mapping), the parent-child edges, and that a message event marks its edge `animating`; `layout` gives captain above crew (y ordering). Then implement + wire App to replay a real log. Full suite green (kernel/cli/tui unaffected), typecheck 0. Commit `feat(observatory): animated React Flow fleet graph replaying a real event log`.

---

### Task O2: Live event source (watch a running mission)

**Files:** `observatory/src/eventSource.ts` (replay | live), a dev bridge `observatory/src/devBridge.mjs` (tails `missions/<id>/events.jsonl`, serves new lines over WebSocket), App live mode.

Live mode: the app subscribes to an event stream; new events fold into the cursor and the graph updates + animates in real time. Dev bridge = a tiny node WS server watching the newest (or a chosen) mission log; the same watch logic moves into the Tauri Rust shell in O3. Auto-follow the latest mission or accept a mission id.

- [ ] Live-update the graph as `flota run` writes events (dev: run a real headless mission, point the bridge at it, watch the graph animate live). Pure event-fold logic unit-tested; the bridge smoke-verified. Commit `feat(observatory): live event source — graph animates as a mission runs`.

---

### Task O3: Tauri shell (native app, Rust file-watch)

**Files:** `observatory/src-tauri/` (Tauri v2 init: Cargo.toml, tauri.conf.json, src/main.rs), Rust file-watcher (`notify` crate) that watches the missions dir / a mission log and `emit`s each new event line to the webview via Tauri's event API; `eventSource.ts` gains a `tauri` mode using `@tauri-apps/api` `listen`. (Requires the Rust toolchain.)

App opens as a native window (macOS first), persistent, no browser. `npm run tauri dev` for dev, `npm run tauri build` for the app bundle. The Rust watcher replaces the O2 dev WS bridge in production.

- [ ] `npm run tauri dev` opens the native window rendering the live graph; a real `flota run` mission animates in it. Document build. Commit `feat(observatory): Tauri native shell with Rust event file-watch`.

---

### Task O4: Polish + package + live verify

**Files:** node visual polish (state colors/pulse, driver badges, cost ticker, mission title, escalation highlight), inspector panel, dagre spacing; `npm run tauri build` macOS bundle; README observatory section.

- [ ] Build the `.app`, run a real `flota run` mission and watch the fleet animate end-to-end in the native window (captain → crew spawn → messages pulse → completion). Ledger + commit `feat(observatory): visual polish + macOS app bundle`. (Arthur drives the final live look.)

## Deferred (v0.4.1)
- **Steering from the app** (select a node, type, inject) — needs write-back to the live kernel (a localhost control socket the running mission listens on, or an instruction file it polls). Read-only ships first.
- Windows/Linux Tauri builds (CI task).

## Self-Review (inline)
Core visual ✓ (O1, de-risks the animated graph on real data first), live ✓ (O2), native shell ✓ (O3), package ✓ (O4). Reuses kernel `reduce()` so graph==reality. Steering deferred (needs a new write-back channel). Risk: React Flow live-update perf (fine at ≤100 nodes per research); Tauri/Rust first-build friction (O3 — mitigated by O1/O2 proving the frontend shell-agnostically first).
