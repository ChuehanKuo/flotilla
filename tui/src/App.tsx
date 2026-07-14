import { useEffect, useReducer, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Mission } from '@flota/kernel';
import { fleetRows, nodeFeed, initialUi, pickAnswerTarget, type UiState } from './viewModel.js';
import { keyToAction, applyAction, inkKeyToKeyInput } from './keymap.js';
import { FleetTree } from './components/FleetTree.js';
import { Inspector } from './components/Inspector.js';
import { InputBar } from './components/InputBar.js';
import { EscalationInbox } from './components/EscalationInbox.js';

export interface AppProps {
  mission: Mission;
}

export function App({ mission }: AppProps) {
  const { exit } = useApp();
  // WHY a ref, not useState, for ui: Ink's useInput resubscribes its listener
  // in a useEffect, which is one render behind a burst of synchronous
  // keystrokes (e.g. an operator's paste, or a test driving stdin.write() in
  // a tight loop with no awaits between calls). A stale listener closure
  // reading React state directly would see last-render's ui and drop or
  // misapply fast keystrokes. uiRef.current is written synchronously inside
  // the same handler call that reads it, so every keystroke — even one
  // handled by a not-yet-resubscribed listener — sees the true latest ui.
  const uiRef = useRef<UiState>(initialUi());
  // WHY a bare counter bump, not derived state: the source of truth for the
  // fleet view is mission.log.events (append-only) — reduce()/fleetRows()/
  // nodeFeed() are recomputed fresh every render straight off it. This tick
  // only exists to ask React to re-render (after a log event, or after a
  // uiRef mutation); it carries no data of its own.
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsubscribe = mission.log.subscribe(() => tick());
    // The TUI is the answer surface, not a blocking readline (unlike the CLI):
    // this only needs to force a re-render — the inbox itself is derived from
    // mission.state().openEscalations, which the log subscription above
    // already keeps fresh on every escalation (ESCALATE is always logged).
    mission.onOperatorEscalation(() => tick());
    return unsubscribe;
  }, [mission]);

  const state = mission.state();
  const rows = fleetRows(state);
  const ui = uiRef.current;

  useEffect(() => {
    if (state.status !== 'running') exit();
  }, [state.status, exit]);

  // Convenience default: land on the captain row without requiring a keypress.
  // keyToAction/applyAction stay pure and untouched — 'move' already knows how
  // to select rows[0] when nothing is selected; this just seeds that once.
  useEffect(() => {
    if (!uiRef.current.selectedNodeId && rows.length > 0) {
      uiRef.current = applyAction(uiRef.current, { type: 'select', nodeId: rows[0]!.id }, rows);
      tick();
    }
    // WHY [rows.length] only: re-running on every rows change (not just count)
    // would fight the operator's own selection once one exists; this effect's
    // job is solely to seed an initial selection, once.
  }, [rows.length]);

  useInput((input, key) => {
    const current = uiRef.current;
    const action = keyToAction(inkKeyToKeyInput(input, key), current);

    if (action.type === 'submit') {
      // SUBMIT TIMING CONTRACT (keymap.ts): capture ui.input and the mode's
      // target BEFORE applyAction resets ui to browse/empty.
      const text = current.input;
      const mode = current.mode;
      const targetNodeId = current.selectedNodeId;
      // WHY mission.state() here, not the render-closure `state`: this
      // handler fires on a raw keystroke and can run against a `state` that
      // hasn't caught up with the latest log events yet (same staleness
      // class the uiRef fix above addresses for ui, just for mission state).
      const escalation = pickAnswerTarget(mission.state().openEscalations, targetNodeId);
      uiRef.current = applyAction(current, action, rows);
      if (mode === 'instruct' && targetNodeId) {
        const res = mission.instruct(targetNodeId, text);
        if (!res.ok) uiRef.current = { ...uiRef.current, notice: res.reason };
      } else if (mode === 'answer' && escalation) {
        mission.answerEscalation(escalation.taskId, text);
      }
      tick();
      return;
    }
    if (action.type === 'kill') { mission.cancel('operator kill (TUI)'); return; }
    if (action.type === 'quit') { exit(); return; }
    uiRef.current = applyAction(current, action, rows);
    // any action other than a (handled-above) submit clears a stale notice —
    // keeps it transient without needing a timer.
    if (current.notice) uiRef.current = { ...uiRef.current, notice: undefined };
    tick();
  });

  const answerTarget = ui.mode === 'answer' ? pickAnswerTarget(state.openEscalations, ui.selectedNodeId) : undefined;

  return (
    <Box flexDirection="column">
      <EscalationInbox escalations={state.openEscalations} />
      <Box>
        <Box width={44}>
          <FleetTree rows={rows} selectedNodeId={ui.selectedNodeId} />
        </Box>
        <Inspector nodeId={ui.selectedNodeId} lines={ui.selectedNodeId ? nodeFeed(mission.log.events, ui.selectedNodeId) : []} />
      </Box>
      <InputBar mode={ui.mode} input={ui.input} answerTarget={answerTarget} />
      {ui.notice ? <Text color="red">! {ui.notice}</Text> : null}
    </Box>
  );
}
