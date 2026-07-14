import type { Key as InkKey } from 'ink';
import type { NodeRow, UiState } from './viewModel.js';

export type Action =
  | { type: 'select'; nodeId: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'enterInstruct' }
  | { type: 'enterAnswer' }
  | { type: 'cancelInput' }
  | { type: 'inputChar'; ch: string }
  | { type: 'backspace' }
  | { type: 'submit' }
  | { type: 'kill' }
  | { type: 'quit' }
  | { type: 'none' };

// Shape mirrors Node's readline 'keypress' event (name/ctrl/sequence). Ink's
// useInput does NOT hand this shape to raw key handlers — it hands
// (input: string, key: Key), where Key carries BOOLEAN flags (key.upArrow,
// key.return, key.backspace, key.ctrl, ...), not {name, ctrl, sequence}. The
// Ink shell must adapt via inkKeyToKeyInput() below before calling keyToAction.
export interface KeyInput {
  name: string;
  ctrl: boolean;
  sequence: string;
}

// Pure adapter from Ink's useInput callback shape to KeyInput above. Kept
// here (not buried in a component) so it's unit-testable without rendering
// anything — only a type import from 'ink' (erased at build time), no Ink
// runtime dependency.
export function inkKeyToKeyInput(input: string, key: InkKey): KeyInput {
  if (key.upArrow) return { name: 'up', ctrl: key.ctrl, sequence: input };
  if (key.downArrow) return { name: 'down', ctrl: key.ctrl, sequence: input };
  if (key.leftArrow) return { name: 'left', ctrl: key.ctrl, sequence: input };
  if (key.rightArrow) return { name: 'right', ctrl: key.ctrl, sequence: input };
  if (key.return) return { name: 'return', ctrl: key.ctrl, sequence: input };
  if (key.escape) return { name: 'escape', ctrl: key.ctrl, sequence: input };
  if (key.backspace || key.delete) return { name: 'backspace', ctrl: key.ctrl, sequence: input };
  return { name: input, ctrl: key.ctrl, sequence: input };
}

function isPrintable(seq: string): boolean {
  if (seq.length !== 1) return false;
  const code = seq.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export function keyToAction(key: KeyInput, ui: UiState): Action {
  // Ctrl-C means different things depending on mode: in browse it kills the
  // mission outright (the operator is in control there); inside instruct/
  // answer it cancels the compose buffer back to browse — so a stray Ctrl-C
  // while composing text can't accidentally kill a running mission, and it
  // matches the terminal-standard "Ctrl-C abandons the current line" reflex.
  if (key.ctrl && key.name === 'c') {
    return ui.mode === 'browse' ? { type: 'kill' } : { type: 'cancelInput' };
  }

  if (ui.mode === 'browse') {
    if (key.name === 'j' || key.name === 'down') return { type: 'move', delta: 1 };
    if (key.name === 'k' || key.name === 'up') return { type: 'move', delta: -1 };
    if (key.name === 'i') return { type: 'enterInstruct' };
    if (key.name === 'a') return { type: 'enterAnswer' };
    if (key.name === 'q') return { type: 'quit' };
    return { type: 'none' };
  }

  // instruct / answer mode
  if (key.name === 'return' || key.name === 'enter') return { type: 'submit' };
  if (key.name === 'escape') return { type: 'cancelInput' };
  if (key.name === 'backspace') return { type: 'backspace' };
  if (isPrintable(key.sequence)) return { type: 'inputChar', ch: key.sequence };
  return { type: 'none' };
}

// Pure UI transition only — no side effects. The caller performs the actual
// mission.instruct / mission.answerEscalation / mission.cancel calls.
//
// SUBMIT TIMING CONTRACT: applyAction(ui, { type: 'submit' }, rows) resets ui
// to { mode: 'browse', input: '' } as part of the transition back to browse.
// The caller MUST read ui.input (the text the operator typed) BEFORE calling
// applyAction with a 'submit' action, then use that captured string to drive
// the side effect. Reading ui.input from the RETURN VALUE of applyAction on
// submit will observe '', not what was typed.
export function applyAction(ui: UiState, a: Action, rows: NodeRow[]): UiState {
  switch (a.type) {
    case 'select':
      return { ...ui, selectedNodeId: a.nodeId };
    case 'move': {
      if (rows.length === 0) return ui;
      const idx = ui.selectedNodeId ? rows.findIndex(r => r.id === ui.selectedNodeId) : -1;
      if (idx === -1) return { ...ui, selectedNodeId: rows[0].id };
      const next = Math.min(rows.length - 1, Math.max(0, idx + a.delta));
      return { ...ui, selectedNodeId: rows[next].id };
    }
    case 'enterInstruct':
      // instructing (and answering, below) always targets the selected node
      // — with nothing selected there is no node to address, so no-op.
      if (!ui.selectedNodeId) return ui;
      return { ...ui, mode: 'instruct', input: '' };
    case 'enterAnswer':
      if (!ui.selectedNodeId) return ui;
      return { ...ui, mode: 'answer', input: '' };
    case 'inputChar':
      return { ...ui, input: ui.input + a.ch };
    case 'backspace':
      return { ...ui, input: ui.input.slice(0, -1) };
    case 'submit':
    case 'cancelInput':
      return { ...ui, mode: 'browse', input: '' };
    case 'kill':
    case 'quit':
    case 'none':
      return ui;
    default:
      return ui;
  }
}
