# Flota v0.3 — MCP tools (reliable delegation)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Replace the unreliable fenced-JSON-in-prose protocol for CLI-driver nodes with **real MCP tools**. A captain that decides to delegate makes a structured `mcp__flota__delegate` tool call it cannot narrate around — reliable by construction. Fixes the confirmed live failure (captain narrated "I delegated," 0 crew spawned).

**Architecture (VERIFIED live in the M1 spike — see `.superpowers/sdd/mcp-spike-findings.md`):**
The kernel hosts ONE in-process Streamable HTTP MCP server per mission (`@modelcontextprotocol/sdk@1.29.0`, `McpServer.registerTool` + `StreamableHTTPServerTransport` stateless, bound 127.0.0.1:random-port). It exposes delegate/report/deliver/escalate/answer as real tools whose handlers close over the calling node's `KernelApi` context (routed by a per-node bearer token). Each CLI agent is spawned wired to that server (claude: `--mcp-config`+`--allowedTools`+`--strict-mcp-config`; codex: `-c mcp_servers.flota.url`+`default_tools_approval_mode="approve"`). Tool calls hit the kernel over HTTP DURING the agent's run and route into the live mission. The fenced-JSON layer (`PROTOCOL_INSTRUCTIONS`/`parseCommands`/`formatTurnPrompt`) is retired for MCP nodes. The resume-based multi-turn model is unchanged; only *how actions happen* changes. The `api` (AI SDK native-tools) driver is untouched — it was already reliable.

**Tech stack:** existing + `@modelcontextprotocol/sdk@^1.29`, `express@^5` (or node:http), `zod@^4` (SDK peer — note: kernel currently uses zod 3; the MCP server module may need zod 4 in an isolated import — verify compat, see M2).

## Global Constraints

- **Scope:** claude-code via MCP is the critical path (default fleet). codex-via-MCP is the LAST task (M6), optional — its wiring is verified but fiddlier (trusted-dir + `default_tools_approval_mode="approve"` + per-mission CODEX_HOME + `< /dev/null`).
- Verified wiring facts (from the spike findings — read that file; do not re-derive):
  - claude tool-call event: `{type:'assistant', message.content[].type:'tool_use', name:'mcp__flota__<tool>', input:{...}}`; result: `{type:'user', message.content[].type:'tool_result', tool_use_id, content:[{type:'text',text}]}` (also top-level `tool_use_result`). Tool name on the wire = `mcp__<serverKey>__<tool>` where serverKey is the `mcpServers` key (`flota`).
  - claude invocation adds `--strict-mcp-config` so ONLY the Flota server loads (avoids the user's global MCP servers + the tool-deferral hop the spike observed).
  - codex tool-call events: `item.started`/`item.completed` with `item.type==='mcp_tool_call'`, `item.server`, `item.tool`, `item.arguments`, `item.result.content[].text` | `item.error.message`.
- The MCP server binds 127.0.0.1 only (never a public interface); per-node bearer token in the `Authorization` header identifies the node; an unknown/absent token → 401.
- Tests never spawn real agent CLIs and never bind a fixed port (use port 0 / an ephemeral port). Real-CLI runs happen only in M5/M6 (live verification).
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (new/changed)
```
kernel/src/mcp/server.ts     # FlotaMcpServer: hosts the 5 tools over Streamable HTTP, token→node routing
kernel/src/mcp/tokens.ts     # per-node token issue/verify (or inline in server)
kernel/src/drivers/mcpClaude.ts  # claude-code driver in MCP mode (or a CliDriver mode)
kernel/src/kernel.ts         # Mission hosts the server, issues tokens, wires MCP nodes, retires fenced-JSON for them
kernel/src/types.ts          # NodeRef/driver mode marker if needed
kernel/src/index.ts          # exports
```

---

### Task M2: FlotaMcpServer — in-process MCP tool host

**Files:** Create `kernel/src/mcp/server.ts`, `kernel/src/mcp/tokens.ts`; `kernel/test/mcpServer.test.ts`. Add `@modelcontextprotocol/sdk` + `express` to kernel/package.json.

**Interfaces (exact):**
```ts
export interface McpNodeContext { nodeId: string; role: 'captain' | 'crew'; api: KernelApi; taskId: string }
export class FlotaMcpServer {
  constructor();
  registerNode(ctx: McpNodeContext): string;   // returns a bearer token for this node
  unregisterNode(nodeId: string): void;
  start(): Promise<{ url: string; port: number }>;  // binds 127.0.0.1:0 (ephemeral); url = http://127.0.0.1:<port>/mcp
  stop(): Promise<void>;
}
```
The 5 tools registered via `server.registerTool(name, {description, inputSchema}, handler)`:
- `delegate` (captain only) `{role, charter, task}` → `ctx.api.delegate(ctx.nodeId, args)` → returns its string result as `{content:[{type:'text',text}]}`.
- `report` (crew only) `{text}` → `ctx.api.emitMessage({kind:'REPORT', from:ctx.nodeId, to:<parent>, taskId:ctx.taskId, text})`.
- `deliver` `{text}` → emit DELIVER; `escalate` `{question}` → emit ESCALATE; `answer` (captain only) `{taskId,text}` → emit ANSWER.
Role enforcement: a crew calling `delegate`/`answer`, or a captain calling `report`, returns an error content `"error: <tool> is not available to this role"` (do not throw). The per-request node is resolved from the `Authorization: Bearer <token>` header → `McpNodeContext`; unknown token → HTTP 401. Because the transport is stateless (new server+transport per POST), the tool handlers must capture the node context from the request — implement by reading the token in the express handler and constructing/selecting the McpServer instance (or a per-request McpServer whose tools close over the resolved ctx). Follow the spike's stateless pattern (`sessionIdGenerator: undefined`, new server+transport per request, `res.on('close')` cleanup).

- [ ] TDD with an in-process MCP **client** (`@modelcontextprotocol/sdk/client` + a StreamableHTTP client transport, or a raw JSON-RPC POST with the bearer header) — NO real CLI: start the server, register a captain node with a spy KernelApi, call `delegate` with the captain token → assert `api.delegate` was called with the args and the tool returned the string; call `report` with the captain token → assert the role-error content; register a crew node, call `report` → assert `api.emitMessage` REPORT; unknown token → 401. Ephemeral port. Verify zod 3-vs-4 compatibility (the SDK wants zod 4 for its schemas — if kernel's zod 3 conflicts, isolate: the MCP inputSchema can use the SDK's bundled zod; document the resolution). Full suite green, typecheck 0. Commit `feat(kernel): in-process MCP server hosting coordination tools`.

---

### Task M3: MCP-mode claude-code driver

**Files:** Create `kernel/src/drivers/mcpClaude.ts` (or extend CliDriver with an mcp mode); `kernel/test/mcpClaude.test.ts`, a stub `kernel/test/fixtures/fake-claude-mcp.sh`.

**Behavior:** `McpClaudeDriver` implements TurnDriver. Given TurnInput plus per-node `{ mcpUrl, token }` (threaded via NodeDeps or the driver ctx — see M4), it:
- Builds args: `['-p', promptText, '--mcp-config', JSON.stringify({mcpServers:{flota:{type:'http', url: mcpUrl, headers:{Authorization:\`Bearer ${token}\`}}}}), '--strict-mcp-config', '--allowedTools', 'mcp__flota__*', '--output-format', 'stream-json', '--verbose']`; first turn adds `--append-system-prompt <system + MCP_TOOL_GUIDANCE>`; later turns use `--resume <sessionId>` (re-passing mcp-config + allowedTools, which the spike confirmed are NOT remembered).
- `MCP_TOOL_GUIDANCE` (replaces PROTOCOL_INSTRUCTIONS): brief text telling the agent it has real flota tools (delegate/report/deliver/escalate/answer) and MUST use them to act — "call the tool; do not describe the action." (Much shorter than the old fenced-JSON instructions.)
- promptText = the `[command results]`-style pending header is NO LONGER needed for command results (tools return inline), BUT crew DELIVER/REPORT arriving as inbound messages to the captain still format as `[KIND from …]` — keep that. The pending-command-results queue is removed for MCP mode (tool results feed back inline via MCP).
- Parses the stream-json: extract session_id, usage, the final assistant text (displayText), and LOG each `tool_use`/`tool_result` as observability events. Does NOT parse fenced-JSON commands (they don't exist in MCP mode) — the tools already executed via HTTP during the run.
- Returns `{text: finalAssistantText, responseMessages:[], usage, billing:'subscription'}`.
- Preserve: no-env-override (but the mcp-config carries the token, fine), abort/timeout/maxBuffer, retry-then-fail on unparseable output, drain-after-success (no queue now, but session handling stays coherent).

- [ ] TDD with a stub `fake-claude-mcp.sh` that ACTUALLY exercises the round-trip: the stub reads its `--mcp-config` arg, makes a real MCP client `delegate` call to the (test-hosted FlotaMcpServer) URL with the bearer token, then emits stream-json lines (a tool_use event, a tool_result event with the server's response, and a final assistant text). The test: stand up a FlotaMcpServer with a spy KernelApi, register a captain node, run McpClaudeDriver with the stub as `bin`, assert (a) `api.delegate` fired (proving the driver wired the server+token correctly end-to-end), (b) the driver logged the tool_use/tool_result events, (c) the final text is returned. Full suite green, typecheck 0. Commit `feat(kernel): MCP-mode claude-code driver (structured tool calls)`.

---

### Task M4: Kernel integration — mission hosts server, wires MCP nodes, retires fenced-JSON

**Files:** Modify `kernel/src/kernel.ts`, `kernel/src/types.ts`, `kernel/src/index.ts`; `kernel/test/mcpMission.test.ts`.

**Behavior:**
- `Mission.start()` creates + `start()`s a `FlotaMcpServer`, stores its url; `finish()` `stop()`s it.
- `spawn()`: for a claude-code node, register it with the MCP server (`registerNode({nodeId, role, api, taskId})` → token), build an `McpClaudeDriver` (via the driverFactory, threading `{mcpUrl, token}`), and DO NOT inject fenced-JSON tools/PROTOCOL_INSTRUCTIONS. The node's `KernelApi` (delegate/emitMessage) is the same one coordination.ts builds — the MCP tool handlers call it.
- Retire for MCP nodes: `makeCoordinationTools`/`formatTurnPrompt`/`PROTOCOL_INSTRUCTIONS` are not used. (Keep the code for the `api` driver, which still uses `makeCoordinationTools` as AI-SDK native tools.) The `deliver` tool now ends the task via a real call; auto-deliver stays only as a safety net (unchanged guards).
- driverFactory signature gains the per-node MCP wiring (`{mcpUrl, token}`) in the ctx it already receives (`{workspaceDir}` → `{workspaceDir, mcpUrl, token}`).
- Node identity for role: captain vs crew from the spawn (captain flag).

- [ ] TDD `mcpMission.test.ts`: a full mission using McpClaudeDriver backed by the stub-claude-mcp (which drives real MCP calls into the hosted server): captain's stub calls `delegate` twice → assert 2 crew `node.spawned` + ORDER routed (the reliability the whole task exists for — delegation happens via structured tool call, not parsed text); crew stubs call `deliver` → captain resumed → captain stub calls `deliver` → mission completes. Assert the fenced-JSON path is NOT exercised (no PROTOCOL_INSTRUCTIONS in any spawned arg). Full suite green, typecheck 0. Commit `feat(kernel): wire claude-code nodes to MCP tools; retire fenced-JSON for them`.

---

### Task M5: Live verification (claude-code) — reliability, not one lucky run

**Files:** README MCP note; ledger. No new unit tests (this is the live proof).

**Live acceptance (real claude-code, default fleet):** Run the demo mission **3 times** (reliability is the point — the old protocol worked ~1 in N):
```
npx tsx cli/src/index.ts run "Survey the fairness metrics used to evaluate ICU mortality-risk prediction models. Delegate scanning and critique to separate crew, then deliver a structured brief." --headless
```
Each run must: captain **delegates via `mcp__flota__delegate`** (verify ≥2 `tool.called`/spawn events in the log — NOT captain-only), crew spawn + run + deliver, mission completes with a real synthesized brief (not narration). Then one run in the TUI to confirm tool calls show in the node feed. If any run regresses to captain-only, that's a finding — investigate the stream/tool wiring before declaring done. Ledger the 3 outcomes.

- [ ] Run live ×3 headless + 1 TUI, verify reliable delegation, ledger, commit `docs: MCP delegation verified reliable across runs`. (Arthur drives the TUI run; the 3 headless can run unattended.)

---

### Task M6 (optional, last): codex MCP mode — restore multi-provider

**Files:** `kernel/src/drivers/mcpCodex.ts`; per-mission CODEX_HOME setup; tests.

Mirror M3 for codex using the spike's verified wiring: per-mission `CODEX_HOME` dir with a `config.toml` marking the mission workspace `trust_level="trusted"` and the flota MCP server (`[mcp_servers.flota] url=... default_tools_approval_mode="approve"` + bearer via env/`bearer_token_env_var`); invoke `codex exec ... -c mcp_servers.flota.url=... -c mcp_servers.flota.default_tools_approval_mode="approve" --json --sandbox workspace-write --cd <workspace> < /dev/null`; parse `item.started`/`item.completed` (`type==='mcp_tool_call'`) for tool events + final text. Stub-tested like M3; live-verified. Un-demote codex from experimental once reliable. Commit `feat(kernel): MCP-mode codex driver; restore multi-provider`.

## Self-Review (inline)
Coverage: server ✓ (M2), claude MCP driver ✓ (M3), kernel wiring + fenced-JSON retirement ✓ (M4), reliability proof ✓ (M5), codex ✓ (M6 optional). Risk: zod 3/4 split (M2 — isolate/verify); the stateless per-request server must resolve node context from the token (M2 core challenge); reliability can only be proven live (M5, ×3). The whole point is that structured tool calls remove the narrate-instead-of-act failure — M5 is the real gate.
