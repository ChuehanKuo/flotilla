# Flota v0.2 — Generic CLI driver + Operator injection + TUI

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Flota provider-agnostic (drive any agent CLI the user already has, no bundled auth), let the operator inject prompts into any running node, and render the fleet as a live full-screen TUI in the user's own terminal.

**Architecture:** Builds on v0.1 (merged, main @ 7375fa6). The `TurnDriver` seam and event-log kernel are unchanged in spirit. Three additions: (1) a config-driven `CliDriver` that generalizes the hardcoded claude-code/codex drivers into presets of one spec-parameterized class; (2) an `INSTRUCT` message + `Mission.instruct(nodeId, text)` for operator→any-node injection; (3) an Ink TUI whose logic is pure/tested and whose Ink shell is thin, subscribed to the mission's event log and calling back into the kernel.

**Tech stack:** existing (Node ≥20, TS ESM, vitest) + `ink@^5`, `react@^18`, `ink-testing-library@^4` (TUI only).

## Global Constraints

- New message kind `INSTRUCT` (operator → a live node; guidance for its next turn; never changes task ownership or state). Existing kinds unchanged. A2A task states unchanged.
- The generic `CliDriver` must reproduce the EXACT current claude-code and codex behavior when constructed from their presets — the existing driver test suites (claudeCode.test.ts, codex.test.ts) must stay green unchanged (the two classes become thin subclasses/presets).
- No bundled auth ever: drivers only spawn a user's CLI via `execFile` (no shell), inheriting process env. A user-defined driver spec supplies command + arg builders + an output parser.
- TUI logic (view-model derivation, key handling) lives in pure functions with unit tests; Ink components are the thin render layer. The TUI reads state only via `reduce(log.events)` / log subscription and mutates the mission only through its public methods (`instruct`, `answerEscalation`, `cancel`). It never reaches into kernel internals.
- Tests never spawn real agent CLIs (stub binaries) and never render to a real TTY (ink-testing-library).
- Commits end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run tests from repo root: `npx vitest run`.

## File structure (new/changed)

```
kernel/src/drivers/cliDriver.ts        # generic spec-driven CliDriver (turn loop shared)
kernel/src/drivers/specs.ts            # CLAUDE_CODE_SPEC, CODEX_SPEC, custom-spec type
kernel/src/drivers/claudeCode.ts       # becomes: preset over cliDriver
kernel/src/drivers/codex.ts            # becomes: preset over cliDriver
kernel/src/kernel.ts                   # + instruct(); INSTRUCT routing
kernel/src/types.ts                    # + 'INSTRUCT'; NodeRef custom spec ref
tui/                                   # new workspace @flota/tui
  src/viewModel.ts                     # pure: FleetState+feed -> view rows
  src/keymap.ts                        # pure: key + ui-state -> action
  src/components/*.tsx                 # Ink: FleetTree, Inspector, InputBar, Inbox
  src/App.tsx                          # Ink root wired to a Mission
  src/index.ts
cli/src/index.ts                       # `run` opens TUI (default) / --headless; `watch`
```

---

### Task V2.1: Generic spec-driven CliDriver (claude-code + codex become presets)

**Files:** Create `kernel/src/drivers/cliDriver.ts`, `kernel/src/drivers/specs.ts`; rewrite `kernel/src/drivers/claudeCode.ts` + `codex.ts` as presets; update `kernel/src/index.ts`; `kernel/test/cliDriver.test.ts`.

**Interfaces (exact):**
```ts
// specs.ts
export interface CliTurnCtx { prompt: string; system: string; workspaceDir: string; protocol: string; sessionId?: string }
export interface CliParseResult { transcript: string; displayText?: string; sessionId?: string; usage: { inputTokens: number; outputTokens: number } }
export interface CliDriverSpec {
  command: string;
  firstArgs(ctx: CliTurnCtx): string[];
  resumeArgs(ctx: CliTurnCtx): string[];   // ctx.sessionId is defined here
  parse(stdout: string): CliParseResult;    // throws on unusable output
  timeoutMs?: number;
}
export const CLAUDE_CODE_SPEC: CliDriverSpec;   // reproduces current claudeCode.ts exactly
export const CODEX_SPEC: CliDriverSpec;         // reproduces current codex.ts exactly

// cliDriver.ts
export class CliDriver implements TurnDriver {
  constructor(spec: CliDriverSpec, opts: { workspaceDir: string; bin?: string; timeoutMs?: number });
  turn(input: TurnInput): Promise<TurnOutput>;   // billing 'subscription', responseMessages []
}
```

`CliDriver.turn` is the current shared turn body (formatTurnPrompt → snapshot pending → execFile(bin ?? spec.command, args, {cwd, signal, timeout, maxBuffer}) → spec.parse(stdout) → drain queue AFTER successful parse → parseCommands(transcript)/executeCommands → text = displayText ?? cleanText). `bin` override (tests) beats `spec.command`. `CLAUDE_CODE_SPEC.parse` / `CODEX_SPEC.parse` are today's `parseStdout` bodies moved verbatim into the specs.

`claudeCode.ts` becomes: `export class ClaudeCodeDriver extends CliDriver { constructor(o: {workspaceDir; bin?; timeoutMs?}) { super(CLAUDE_CODE_SPEC, o); } }` — same for codex. **The existing claudeCode.test.ts / codex.test.ts must pass unchanged** (this is the correctness proof of the extraction).

- [ ] **Step 1:** Failing `cliDriver.test.ts` — a custom spec (echo-style stub via `bin` + a trivial parser) drives a two-turn exchange: first turn uses `firstArgs`, second uses `resumeArgs` with the sessionId from turn 1; a flota block in the transcript executes against a fake ToolSet; billing is 'subscription'. Also: `new ClaudeCodeDriver({workspaceDir, bin})` still produces the exact claude-code first-turn argv (import CLAUDE_CODE_SPEC, assert `firstArgs` output).
- [ ] **Step 2:** Run — fails (no module).
- [ ] **Step 3:** Extract specs + implement CliDriver; reimplement the two driver classes as presets.
- [ ] **Step 4:** `npx vitest run` — cliDriver.test.ts passes AND claudeCode.test.ts + codex.test.ts pass unchanged; typecheck 0.
- [ ] **Step 5:** Commit `refactor(kernel): spec-driven CliDriver; claude-code/codex become presets`.

---

### Task V2.2: Custom driver specs reachable from config + factory

**Files:** `kernel/src/types.ts` (NodeRef gains optional `spec?: CliDriverSpec` for `driver:'custom'`), `kernel/src/providers.ts` (realDriverFactory handles `'custom'` → `new CliDriver(ref.spec, {workspaceDir})`), `kernel/src/index.ts` exports (`CliDriver`, spec types, presets); `kernel/test/providers.test.ts` additions.

**Interfaces:**
```ts
// types.ts — DriverKind gains 'custom'
export type DriverKind = 'api' | 'claude-code' | 'codex' | 'custom';
export interface NodeRef { driver: DriverKind; provider?: Provider; model?: string; spec?: CliDriverSpec }
```
`realDriverFactory`: `driver==='custom'` → require `ref.spec` (throw a clear error if missing) → `new CliDriver(ref.spec, { workspaceDir: ctx.workspaceDir })`. Preflight (`cli/src/run.ts`) for a `custom` ref checks `execFile(ref.spec.command, ['--version'])` best-effort (skip the check if it errors non-ENOENT — many CLIs lack `--version`; only fail on "command not found").

- [ ] TDD: factory test — a NodeRef `{driver:'custom', spec}` yields a CliDriver bound to the spec; `{driver:'custom'}` with no spec throws `'custom driver requires a spec'`. Then implement. Full suite green, typecheck 0. Commit `feat(kernel): custom driver kind — bring your own agent CLI`.

---

### Task V2.3: Operator injection — INSTRUCT + Mission.instruct

**Files:** `kernel/src/types.ts` (`MessageKind` gains `'INSTRUCT'`), `kernel/src/kernel.ts` (`instruct` + routing), `kernel/src/reducer.ts` (INSTRUCT touches lastTs, is otherwise log-only), `kernel/test/instruct.test.ts`.

**Interfaces:**
```ts
// Mission
instruct(nodeId: string, text: string): { ok: boolean; reason?: string };
```
Semantics: if the node is unknown → `{ok:false, reason:'no such node'}`; if its task is terminal (`completed/failed/canceled/rejected`) → `{ok:false, reason:'node finished'}`; else log a `message` event `{kind:'INSTRUCT', from:'operator', to:nodeId, taskId:<node task>, text}` and `enqueue` it on the node (wakes it; incorporated as its next turn's input, exactly like an ORDER/ANSWER batch). INSTRUCT never changes task state. `route()` handles the kind: forward to the node inbox only. Node.ts already formats any inbound message as `[KIND from …]`, so INSTRUCT text reaches the model as `[INSTRUCT from operator · task tN] <text>` with no node change.

- [ ] TDD: a scripted-driver mission; after the captain is `working`, `mission.instruct('captain','also cover pediatric ICUs')` returns `{ok:true}`, a matching INSTRUCT message event is logged, and the node runs another turn whose input contains the instruction. `instruct` on an unknown id and on a completed task return the right `{ok:false}`. Implement, full suite green, typecheck 0. Commit `feat(kernel): operator INSTRUCT injection into any live node`.

---

### Task V2.4: TUI pure layer — view model + keymap

**Files:** create `tui/` workspace (`tui/package.json` `@flota/tui`, deps ink/react, dev ink-testing-library; tsconfig referencing kernel); `tui/src/viewModel.ts`, `tui/src/keymap.ts`; `tui/test/viewModel.test.ts`, `tui/test/keymap.test.ts`. Update root `package.json` workspaces + `vitest.config.ts` projects to include `tui`.

**Interfaces (exact, pure — no Ink):**
```ts
// viewModel.ts
export interface NodeRow { id: string; depth: number; role: string; driver: string; state: TaskState; costUsd: number; isCaptain: boolean }
export interface UiState { selectedNodeId?: string; mode: 'browse' | 'instruct' | 'answer'; input: string }
export function fleetRows(s: FleetState): NodeRow[];                 // tree order, depth from parent chain
export function nodeFeed(events: FleetEvent[], nodeId: string): string[];  // human lines for that node's messages/usage/state
export function initialUi(): UiState;

// keymap.ts
export type Action =
  | { type: 'select'; nodeId: string } | { type: 'move'; delta: 1 | -1 }
  | { type: 'enterInstruct' } | { type: 'enterAnswer' } | { type: 'cancelInput' }
  | { type: 'inputChar'; ch: string } | { type: 'backspace' }
  | { type: 'submit' } | { type: 'kill' } | { type: 'quit' } | { type: 'none' };
export function keyToAction(key: { name: string; ctrl: boolean; sequence: string }, ui: UiState): Action;
export function applyAction(ui: UiState, a: Action, rows: NodeRow[]): UiState;  // pure UI transition (no side effects)
```
Pin with tests: `fleetRows` orders captain→its children depth-first with correct depth; `nodeFeed` includes that node's ORDER/REPORT/DELIVER/INSTRUCT/usage lines and excludes others; in `browse` mode `j/k` move selection and `i` enters instruct mode; in `instruct` mode a char appends to `input`, Enter yields `submit` (caller performs the side effect), Esc → `cancelInput`; `Ctrl-C` → `kill` in browse, `quit` guard elsewhere.

- [ ] TDD both pure modules. Full suite green (kernel unaffected), typecheck 0. Commit `feat(tui): pure fleet view-model and keymap`.

---

### Task V2.5: TUI Ink shell wired to a live Mission

**Files:** `tui/src/components/FleetTree.tsx`, `Inspector.tsx`, `InputBar.tsx`, `EscalationInbox.tsx`, `tui/src/App.tsx`, `tui/src/index.ts` (`renderFleet(mission): { waitUntilExit(): Promise<void> }`); `tui/test/App.test.tsx` (ink-testing-library).

**Behavior:** `App` takes a `Mission`, subscribes to `mission.log` (re-render on each event via a state bump), derives rows via `fleetRows(mission.state())`, renders: left = FleetTree (selected highlighted, state-colored, driver-badged), right = Inspector (`nodeFeed` for the selected node), bottom = InputBar (shows mode + input), and an EscalationInbox banner when `mission.state().openEscalations` is non-empty. Key handling routes through `keyToAction`/`applyAction`; on `submit` in `instruct` mode → `mission.instruct(selectedId, input)`; in `answer` mode → `mission.answerEscalation(taskId, input)`; `kill` → `mission.cancel('operator kill (TUI)')`. `mission`'s `onOperatorEscalation` pushes into the inbox (no blocking readline — the TUI is the answer surface). Unmount when the mission reaches a terminal state.

Test with ink-testing-library + a scripted-driver Mission: assert the captain row renders with its driver badge; simulate `i` + typing + Enter and assert `mission.instruct` was called with the typed text; assert an escalation shows in the inbox and answering it calls `answerEscalation`.

- [ ] TDD the App against a real (scripted-driver) Mission. Full suite green, typecheck 0. Commit `feat(tui): live Ink fleet view with select-and-inject`.

---

### Task V2.6: CLI integration + live verification

**Files:** `cli/src/index.ts` (`run <order>` renders the TUI by default; `--headless` keeps the v0.1 line-tail; add `watch <eventsFile-or-missionDir>` for read-only attach — reuses replay for a completed log, live-tails an in-progress one), `cli/src/run.ts` (factor the mission-construction so both TUI and headless paths share it), README (TUI section + "bring your own CLI" custom-driver example). No new unit tests beyond wiring; this task is the live proof.

**Live acceptance (in Arthur's interactive terminal, all-claude-code default):**
1. `npx tsx cli/src/index.ts run "<order>"` opens the full-screen fleet TUI; captain + crew appear as rows with driver badges and live state.
2. Select a running crew node, press `i`, type an instruction, Enter → an `INSTRUCT` event appears in that node's feed and shapes its next turn.
3. Mission completes; deliverable is shown/printed; `events.jsonl` replays via `watch`.
4. `--headless` still produces the v0.1 line-tail.

- [ ] Wire, add README, run the live check, ledger the result. Commit `feat(cli): TUI-by-default run + watch; bring-your-own-CLI docs`.

## Self-Review (inline)
Coverage: generic driver ✓ (V2.1) + custom-from-config ✓ (V2.2); injection ✓ (V2.3); TUI logic ✓ (V2.4) + shell ✓ (V2.5); terminal-native surface + generalizable docs ✓ (V2.6). Deferred per scope: lateral crew↔crew, Tauri, codex hardening. Risk: Ink testability — mitigated by the pure V2.4 layer carrying the logic and ink-testing-library for the shell.
