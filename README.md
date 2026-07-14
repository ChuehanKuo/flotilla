# Flota

**Status: v0.4 (kernel + CLI + full-screen TUI + Tauri desktop observatory).** Design spec: [docs/specs/2026-07-13-flota-design.md](docs/specs/2026-07-13-flota-design.md).

An event-sourced coordination kernel for hierarchical, multi-provider AI agent fleets — plus a persistent desktop observatory to watch and steer them live. For anyone running multi-agent work, on any terminal and any OS (macOS is the current reference platform).

## The idea

- **A fleet, not a pipeline.** An operator (admiral) issues orders; AI captains decompose and delegate to crew agents; any node can run on any provider (Anthropic, OpenAI, Google, local). Delegation is a tool — calling it spawns a child agent, so hierarchy is recursive by construction.
- **The log is the system.** Every order, spawn, report, escalation, tool call, and cost record is one event in an append-only per-mission log. Live UI, replay, and post-mortems are the same reducer over the same events.
- **Watch it and talk to it.** A persistent Tauri desktop app (macOS/Windows/Linux) renders the fleet as a live animated graph — and lets you inject a message into *any* running node, not just the top. Escalations pause their branch and land in your inbox. A plain CLI covers terminal-only and SSH use.
- **Bounded by construction.** No daemons; per-mission kernels that die at mission end; depth caps, retry-then-escalate, hard per-mission dollar caps the kernel enforces, kill switch.

## Why it doesn't already exist

2026-07 research sweep: every orchestration framework treats its event stream as a tappable byproduct, not the substrate; every observability tool is post-hoc trace trees; nothing does fleet-scale live topology with message-injection steering. Details and citations in the spec.

## Quickstart

Flota's default config rides [Claude Code](https://claude.com/claude-code)
(`claude`), signed in on your subscription — no API keys, $0 marginal.

```bash
npm install
npx tsx cli/src/index.ts run "your mission order here"   # opens the full-screen TUI
# terminal-only / SSH / scripting — v0.1's plain line-tail output:
npx tsx cli/src/index.ts run "your mission order here" --headless
# re-watch any COMPLETED mission's log:
npx tsx cli/src/index.ts watch missions/<mission-id>
```

**Drivers.** `claude-code` (default) is the proven path — captains and crew
delegate, report, and deliver as real MCP tool calls (`mcp__flota__*`)
against an in-process MCP server, live-verified end-to-end (3/3 headless
runs). `codex` (OpenAI's Codex CLI) is **experimental** — v0.3 rebuilt it on
the same MCP wiring (`McpCodexDriver`) and it's unit-tested, but not yet
live-verified against the real `codex` binary; opt in per node at your own
risk pending that verification run. `api` (raw Anthropic/OpenAI keys) is fully
supported: point a node's config at it and export `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` — the hard dollar cap applies there (`--budget`, default
$5). `custom` lets you point a
node at any agent CLI you already have installed (see "Bring your own agent
CLI" below). Subscription nodes are bounded by per-node turn caps, depth
caps, a watchdog, and mission timeouts.

## The TUI

`flota run "<order>"` opens a full-screen fleet view by default (an Ink app —
any terminal, no browser): the fleet tree on the left (captain + crew, each
row showing its driver badge, live task state, and running cost), an
inspector pane on the right for the selected node's message/usage/task-state
feed, an escalation inbox banner across the top whenever a node is blocked
waiting on you, and an input bar along the bottom.

| Key | Action |
| --- | --- |
| `j` / `k` (or `↓` / `↑`) | move the selection up/down the fleet tree |
| `i` | instruct the selected node — send it operator guidance for its next turn, without reassigning the task |
| `a` | answer the open escalation raised by the selected node (falls back to the oldest open escalation) |
| `Enter` | submit the instruct/answer buffer |
| `Esc` | cancel the buffer, back to browse |
| `q` | quit the TUI |
| `Ctrl-C` | kill the mission outright (browse mode); while typing, just cancels the buffer instead — a stray Ctrl-C mid-sentence can't kill a running mission |

`--headless` skips the TUI and reproduces v0.1's plain line-tail output plus
a blocking terminal prompt for escalations — exact same behavior, unchanged.

`flota watch <eventsFile-or-missionDir>` re-renders a **completed** mission's
log (same renderer as `replay`, but also accepts a mission directory). Live
read-only attach to an in-progress mission is a v0.2-later follow-up — to
watch a mission live today, run it with `flota run` (no `--headless`).

## The Observatory (Tauri desktop app)

A persistent native desktop app that renders a fleet as a live animated
graph: nodes colored by task state (grey submitted, teal working with a
sonar-ping pulse, amber input-required, green completed, red failed), the
captain marked with a gold anchor, a driver badge and live running cost on
every node, edges that animate as messages route between parent and child,
and a header showing mission id, status, node count, and total cost — with
an amber banner surfacing any open escalation. Click a node to open the
inspector: its message/usage/task-state feed, color-tagged by event kind.

It reads state the same way the TUI does — folding `missions/<id>/events.jsonl`
through the kernel's own `reduce()` — so the graph can never drift from
reality. Read-only in v0.4 (it watches; steering from the app is a v0.4.1
follow-up).

```bash
npm run tauri dev -w observatory     # native window, dev build, hot reload
npm run tauri build -w observatory   # produces the shippable macOS .app
```

The dev window auto-follows the newest mission under `missions/` as it runs
(no mission id to pass — start a mission with `flota run` in another
terminal and the graph animates live). A plain browser preview also exists
for frontend-only iteration (`npm run dev -w observatory`, replays a bundled
log or `?live=1` against the dev bridge) but the shipped artifact is the
Tauri app, not the browser tab.

## Bring your own agent CLI

The `custom` driver kind lets a node run any agent CLI you already have
installed and signed in — Flota spawns it via `execFile` (no shell, inherits
your process env) once per turn; it never bundles or manages auth itself.
There's no `--driver` flag yet, so wiring one in is config-level: hand-build
a `MissionConfig` and construct `Mission` yourself. Sketch, pointed at a
hypothetical `gemini` CLI (an `aider`-style CLI would look the same — only
`command`/`firstArgs`/`resumeArgs`/`parse` change):

```ts
import { Mission, defaultConfig, realDriverFactory, type CliDriverSpec } from '@flota/kernel';

const geminiSpec: CliDriverSpec = {
  command: 'gemini',
  firstArgs: (ctx) => ['-p', `${ctx.system}\n\n${ctx.protocol}\n\n${ctx.prompt}`, '--json'],
  resumeArgs: (ctx) => ['-p', ctx.prompt, '--session', ctx.sessionId as string, '--json'],
  parse: (stdout) => {
    const last = JSON.parse(stdout.trim().split('\n').pop()!);
    return { transcript: last.text, sessionId: last.session_id, usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

const config = defaultConfig();
config.models.crew = [{ driver: 'custom', spec: geminiSpec }];

const mission = new Mission('your order here', config, { driverFactory: realDriverFactory, missionsDir: './missions' });
mission.log.subscribe(e => console.log(e));
await mission.start();
```

A spec owns exactly two things: how to build `argv` for a first turn versus a
resumed one (from `ctx.prompt` / `ctx.system` / `ctx.protocol` /
`ctx.workspaceDir` / `ctx.sessionId`), and how to reduce the CLI's stdout into
`{ transcript, displayText?, sessionId?, usage }`. `CLAUDE_CODE_SPEC` and
`CODEX_SPEC` in `kernel/src/drivers/specs.ts` are two real, working examples
of the same shape — read either for the full contract (`parse` should throw
on unusable output rather than return empty, so the node's retry-then-
escalate machinery reacts instead of silently losing a turn).

## Protocol posture

Message vocabulary aligned with [A2A](https://a2a-protocol.org) (Task lifecycle, Message/Part, artifacts); UI stream shaped by AG-UI categories; MCP remains the tool layer. Compatibility over compliance in v0.x.

## License

MIT
