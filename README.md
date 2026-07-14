# Flota

**Status: v0.1 (kernel + CLI).** Design spec: [docs/specs/2026-07-13-flota-design.md](docs/specs/2026-07-13-flota-design.md) · desktop observatory app is the next phase.

An event-sourced coordination kernel for hierarchical, multi-provider AI agent fleets — plus a persistent desktop observatory to watch and steer them live. For anyone running multi-agent work, on any terminal and any OS (macOS is the current reference platform).

## The idea

- **A fleet, not a pipeline.** An operator (admiral) issues orders; AI captains decompose and delegate to crew agents; any node can run on any provider (Anthropic, OpenAI, Google, local). Delegation is a tool — calling it spawns a child agent, so hierarchy is recursive by construction.
- **The log is the system.** Every order, spawn, report, escalation, tool call, and cost record is one event in an append-only per-mission log. Live UI, replay, and post-mortems are the same reducer over the same events.
- **Watch it and talk to it.** A persistent Tauri desktop app (macOS/Windows/Linux) renders the fleet as a live animated graph — and lets you inject a message into *any* running node, not just the top. Escalations pause their branch and land in your inbox. A plain CLI covers terminal-only and SSH use.
- **Bounded by construction.** No daemons; per-mission kernels that die at mission end; depth caps, retry-then-escalate, hard per-mission dollar caps the kernel enforces, kill switch.

## Why it doesn't already exist

2026-07 research sweep: every orchestration framework treats its event stream as a tappable byproduct, not the substrate; every observability tool is post-hoc trace trees; nothing does fleet-scale live topology with message-injection steering. Details and citations in the spec.

## Quickstart (v0.1)

Flota's default config rides [Claude Code](https://claude.com/claude-code)
(`claude`), signed in on your subscription — no API keys, $0 marginal.

```bash
npm install
npx tsx cli/src/index.ts run "your mission order here"
# re-watch any past mission:
npx tsx cli/src/index.ts replay missions/<mission-id>/events.jsonl
```

**Drivers.** `claude-code` (default) is the proven path. `codex` (OpenAI's
Codex CLI) is **experimental in v0.1** — the driver exists and is unit-tested,
but hangs on live contact pending real-CLI hardening (v0.2); opt in per node
at your own risk. `api` (raw Anthropic/OpenAI keys) is fully supported: point
a node's config at it and export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — the
hard dollar cap applies there (`--budget`, default $5). Subscription nodes are
bounded by per-node turn caps, depth caps, a watchdog, and mission timeouts.

## Protocol posture

Message vocabulary aligned with [A2A](https://a2a-protocol.org) (Task lifecycle, Message/Part, artifacts); UI stream shaped by AG-UI categories; MCP remains the tool layer. Compatibility over compliance in v0.x.

## License

MIT
