# Flotilla

**Status: design phase.** No code yet — the approved design lives in [`docs/specs/2026-07-13-flotilla-design.md`](docs/specs/2026-07-13-flotilla-design.md).

An event-sourced coordination kernel for hierarchical, multi-provider AI agent fleets — plus a persistent desktop observatory to watch and steer them live. For anyone running multi-agent work, on any terminal and any OS (macOS is the current reference platform).

## The idea

- **A fleet, not a pipeline.** An operator (admiral) issues orders; AI captains decompose and delegate to crew agents; any node can run on any provider (Anthropic, OpenAI, Google, local). Delegation is a tool — calling it spawns a child agent, so hierarchy is recursive by construction.
- **The log is the system.** Every order, spawn, report, escalation, tool call, and cost record is one event in an append-only per-mission log. Live UI, replay, and post-mortems are the same reducer over the same events.
- **Watch it and talk to it.** A persistent Tauri desktop app (macOS/Windows/Linux) renders the fleet as a live animated graph — and lets you inject a message into *any* running node, not just the top. Escalations pause their branch and land in your inbox. A plain CLI covers terminal-only and SSH use.
- **Bounded by construction.** No daemons; per-mission kernels that die at mission end; depth caps, retry-then-escalate, hard per-mission dollar caps the kernel enforces, kill switch.

## Why it doesn't already exist

2026-07 research sweep: every orchestration framework treats its event stream as a tappable byproduct, not the substrate; every observability tool is post-hoc trace trees; nothing does fleet-scale live topology with message-injection steering. Details and citations in the spec.

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

## Protocol posture

Message vocabulary aligned with [A2A](https://a2a-protocol.org) (Task lifecycle, Message/Part, artifacts); UI stream shaped by AG-UI categories; MCP remains the tool layer. Compatibility over compliance in v0.x.

## License

MIT
