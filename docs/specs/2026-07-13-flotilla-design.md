# Flotilla — Design Spec

**Status:** Design approved 2026-07-13. Build **greenlit** 2026-07-13 by explicit operator order ("no gate, go"), overriding path ①'s wait — the conflict analysis in §7 stands as record.
**Author:** Arthur C. Kuo, with Claude (design synthesis from 4-agent research fan-out, 2026-07-13).

---

## 1. Vision

An event-sourced coordination kernel where AI captains decompose the operator's orders and delegate to crew agents on any model provider, every message flows through one append-only log, and a persistent macOS app renders the fleet live — letting the operator watch, and message, any node mid-mission.

Mental model: a fleet. **The operator (admiral)** issues orders → **AI captains** (coordinator nodes) decompose and delegate → **crew** (worker nodes, possibly nested) execute. Any node can run on any provider (Anthropic, OpenAI, Google, local). Substrate-first: the same hierarchy does real work or gets studied — both are readers of the same log.

**Audience:** general-purpose, open-source — anyone running multi-agent work, not Arthur's setup specifically. macOS is the v0.x reference platform (where it gets built and dogfooded); nothing in the architecture is OS- or terminal-specific.

## 2. Research basis (2026-07-13 fan-out, 3 web briefs + 1 vault brief)

1. **The gap is real.** No shipped tool combines (a) live fleet-wide topology, (b) an event-sourced log as the runtime substrate (not a side-channel trace), (c) message-injection steering into any running node. LangGraph Studio has (a)+(c) for one graph; AutoGen Studio has (a)+(c) without event sourcing; `activegraph` ("The Log is the Agent," arXiv 2605.21997) has (b) without a UI. Industry commentary names fleet-scale "message-bus visibility" the #1 missing observability capability.
2. **Don't adopt an orchestration framework.** All surveyed frameworks (LangGraph, MS Agent Framework, CrewAI, OpenAI Agents SDK, Claude Agent SDK, smolagents, ADK, Mastra, Agno) treat the event stream as a byproduct; checkpoints ≠ replay; hierarchy is mostly hardcoded 2-level. Reuse only the model-call layer.
3. **Protocol alignment:** A2A (Linux Foundation, v1.0, 150+ orgs) won agent↔agent — borrow its Task/Message/Part vocabulary and lifecycle states. AG-UI (14.7k★, LF-adjacent) shapes UI-facing streams. MCP stays the tool layer. Full spec compliance is a non-goal for v0.x; vocabulary compatibility is the goal.
4. **Stack:** React Flow comfortably renders 10–100 live nodes (dagre/elk layout, built-in animated edges). Bidirectional channel required for steering (WebSocket, not SSE).

## 3. Architecture — four layers

```
 Operator (admiral) ── orders / escalation answers
   │
   ├── CLI, any terminal (order entry + line-tail + inline replies)
   └── Flotilla.app (persistent Tauri desktop app — the observatory)
             │ WebSocket / localhost
   ┌─────────┴────────── KERNEL (Node/TS, per-mission) ─────────┐
   │  EVENT LOG  — append-only JSONL, source of truth           │
   │  MessageBus — ORDER↓ REPORT↑ DELIVER↑ ESCALATE↑            │
   │  AgentNode  — charter + provider binding + tools + inbox   │
   │  delegate() is a tool → calling it spawns a child node     │
   └────△─────────△─────────△─────────△─────────────────────────┘
     Anthropic   OpenAI   Google    Ollama   (via Vercel AI SDK)
```

### 3.1 Turn drivers (amended 2026-07-14 — subscription pivot, operator decision)
A node's turns are produced by a pluggable `TurnDriver`. Three kinds in v0.1:
- **`api`** — Vercel AI SDK (`generateText`, native tool-calling) over API keys. The open-source default path; ~20 lines per additional provider.
- **`claude-code`** — headless Claude Code (`claude -p`, `--resume` continuity) riding the operator's Claude subscription. Coordination commands travel as a fenced JSON block the driver parses (MCP bridging is the v0.2 upgrade); crew file access = the CLI's own tools cwd'd to the mission workspace.
- **`codex`** — `codex exec` (resumable, workspace-write sandbox) riding the operator's OpenAI subscription; same JSON-command protocol.

v0.1's default config and demo run on the subscription drivers ($0 marginal); the `api` driver stays fully supported and tested. The coordination layer is owned either way.

### 3.2 Kernel
- **AgentNode** = charter (role prompt) + provider/model binding + tool set + inbox. Captain vs crew is not a type: a captain is any node holding the `delegate` tool. `delegate(role, charter, provider, model)` spawns a child node → hierarchy is recursive by construction; depth is a config cap, not an architectural limit.
- **Node loop:** drain inbox → build context → streamed model call → execute tool calls (incl. delegate/report/escalate/deliver, which are tools exposed to the model) → emit events → await next message or terminal state.
- **Human as root node:** the operator is the root of the tree; the same message semantics apply to them.

### 3.3 Message protocol (A2A-aligned)
Envelope: `{ eventId, seq, ts, missionId (≙ A2A contextId), taskId, parentTaskId*, from, to, kind, payload }` (* = Flotilla addition; A2A has no parent-task field).

| Kind | Direction | A2A mapping | Semantics |
|---|---|---|---|
| `ORDER` | down | creates Task, `submitted` | charter + task assignment |
| `REPORT` | up | `working` + TaskStatusUpdateEvent | progress, partial findings |
| `DELIVER` | up | artifact + `completed` | finished work product; artifacts carry stable `name` + `artifactId` |
| `ESCALATE` | up | `input-required` | decision request → parent, or operator at root; branch pauses until answered (Flotilla addition: human-addressable) |

Task states use A2A names verbatim: `submitted / working / input-required / auth-required / completed / failed / canceled / rejected`.

### 3.4 Event log
- One ordered JSONL per mission: `missions/<id>/events.jsonl`. Every order, spawn, report, tool call, state change, token/cost record is an event.
- **No component holds authoritative state**: fleet picture = deterministic fold (reducer) over the log. Live UI, replay, and post-mortem are the same reducer at different cursors.
- Token deltas stream live over the socket but are **not** persisted event-by-event; only message-level events land in the log (bloat control; replay does not need token granularity).

### 3.5 Observatory (Flotilla.app — persistent Tauri desktop app)
Tauri 2 shell (system WebView, ~10MB; one codebase builds macOS/Windows/Linux) around the React Flow canvas. **Persistent**: stays open across missions; new missions auto-attach (app watches the missions dir / localhost socket). Explicitly not a browser tab; nothing reopens per mission.
- Live org chart — nodes colored by provider, badged by state; messages animate along edges.
- Node inspector — transcript, tool calls, tokens, cost per node.
- Order console — inject a message into **any** running node (the confirmed market gap), not only the root captain.
- Escalation inbox — queued `input-required` items with context; answering resumes the branch. Native OS notifications (Tauri, cross-platform).
- Kill switch + live cost ticker, always visible.
- Replay — v0.1: minimal event-stepper over a past mission's log (same reducer as live).

### 3.6 CLI (any terminal)
`flotilla "<order>"` boots a per-mission kernel, prints a compact one-line-per-event tail, supports inline escalation replies. Terminal-agnostic (iTerm2, Terminal.app, Windows Terminal, VS Code pane, SSH) and fully usable without the app. CLI and app both merely append/read the same log — entry point is architecturally irrelevant.

## 4. Safety rails (kernel-enforced — the OpenClaw post-mortem answers)

| OpenClaw failure (2026-07-09 audit) | Countermeasure |
|---|---|
| launchd gateway crash-looped silently for 32 days (~144k respawns) | **No daemon, ever.** Kernel exists only while a mission runs; missions carry wall-clock timeouts; nothing auto-respawns. The persistent app is a *viewer*, not autonomous infra. |
| Unbounded agent recursion risk | Depth cap default 2 (hard max 3); max children per node; max concurrent nodes per mission. |
| Retry loops | Retry budget = 1, then mandatory `ESCALATE`. |
| Zero visibility while failing | Visibility is the product; watchdog: node silent > 10 min default (config; CLI-driver turns are slow) → auto-`ESCALATE` to operator, answerable. |
| Cost drift | Hard $ cap per mission (default $5) and per node — kernel **refuses** model calls past cap (api-driver nodes; subscription turns log usage at $0). Live ticker. Kill switch cancels all in-flight work, logged as `canceled`. |
| Subscription runaway (no $ signal) | Per-node turn cap (`maxTurnsPerNode`, default 20) — kernel refuses further turns, node escalates. Depth/watchdog/timeout rails apply unchanged. |

## 5. v0.1 vertical slice

**In:** kernel; turn drivers `api` (Anthropic + OpenAI via AI SDK), `claude-code`, and `codex` (subscription CLIs, JSON-command protocol, stub-binary tested); 1 captain + N crew (depth-2 config); 4 message kinds; JSONL log + reducer; CLI (order entry, line-tail, inline replies); Flotilla.app (live chart, inspector, order console, escalation inbox, kill switch, cost ticker, minimal replay stepper); crew file access sandboxed to `missions/<id>/workspace/` (kernel lexical guard for api nodes; CLI-native tools cwd'd to the workspace for subscription nodes — documented as weaker). Cross-platform code throughout; built and tested on macOS only in v0.1. Demo mission (amended 2026-07-14): runs on the operator's subscriptions — captain on `claude-code`, crew split across `claude-code` and `codex`; no API keys required.

**Out (backlog):** Google/Ollama adapters; depth-3+ default; shell/network tools for crew; polished replay scrubbing; external A2A interop; browser-served observatory; Ink TUI full-screen mode; multi-mission concurrency in one kernel.

## 6. Repository & licensing

GitHub project under Arthur's account, **private during design/build; to be open-sourced later** (explicit intent, 2026-07-13). MIT license from day one so open-sourcing is a visibility flip, not a relicensing exercise. TypeScript end-to-end; npm; monorepo layout when build starts: `kernel/`, `cli/`, `app/`, `docs/`.

Naming note: "flotilla" has prior OSS art (e.g., Uber's archived job-execution service). Not a blocker for a personal repo; revisit distinctiveness before public launch.

## 7. Governance decision (2026-07-13)

This project conflicts with three written positions: the hot.md **subtraction mandate** (drop ≥1 thread by 7/29), the **OpenClaw precedent** (only prior multi-agent infra failed silently 32 days, never fully post-mortemed), and the **OPERATING-MANUAL meta-gate** ("armies only downstream of LOCKED"; retooling-payoff test running through 2026-08-31).

**Chosen path ①: spec now, build gated.** The spec is the LOCKED-seeking artifact the meta-gate requires; implementation planning (superpowers:writing-plans) and build begin only after the 7/29 subtraction executes or an explicit greenlight. §4 exists so that when the build happens, it answers the OpenClaw precedent by construction rather than repeating it.

## 8. Open questions (deferred, not blocking)

- Lateral messaging (crew↔crew `QUERY`/`ANSWER`) — v0.1 routes everything through the tree; flat gossip is a deliberate non-goal until a mission demonstrates need.
- Mission templates (reusable captain charters) — after ≥3 real missions.
- Whether the reducer state should be additionally checkpointed (SQLite) for very long missions — measure first.
