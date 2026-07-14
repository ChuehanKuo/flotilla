import { describe, it, expect } from 'vitest';
import { keyToAction, applyAction, type KeyInput } from '../src/keymap.js';
import { initialUi } from '../src/viewModel.js';
import type { NodeRow } from '../src/viewModel.js';

function key(partial: Partial<KeyInput>): KeyInput {
  return { name: '', ctrl: false, sequence: '', ...partial };
}

function row(id: string): NodeRow {
  return { id, depth: 0, role: 'r', driver: 'claude-code', state: 'working', costUsd: 0, isCaptain: id === 'captain' };
}

const rows: NodeRow[] = [row('captain'), row('crew-1'), row('crew-2')];

describe('keyToAction — browse mode', () => {
  const ui = initialUi();

  it('j / down moves selection forward', () => {
    expect(keyToAction(key({ name: 'j', sequence: 'j' }), ui)).toEqual({ type: 'move', delta: 1 });
    expect(keyToAction(key({ name: 'down' }), ui)).toEqual({ type: 'move', delta: 1 });
  });

  it('k / up moves selection backward', () => {
    expect(keyToAction(key({ name: 'k', sequence: 'k' }), ui)).toEqual({ type: 'move', delta: -1 });
    expect(keyToAction(key({ name: 'up' }), ui)).toEqual({ type: 'move', delta: -1 });
  });

  it('i enters instruct mode, a enters answer mode', () => {
    expect(keyToAction(key({ name: 'i', sequence: 'i' }), ui)).toEqual({ type: 'enterInstruct' });
    expect(keyToAction(key({ name: 'a', sequence: 'a' }), ui)).toEqual({ type: 'enterAnswer' });
  });

  it('q quits', () => {
    expect(keyToAction(key({ name: 'q', sequence: 'q' }), ui)).toEqual({ type: 'quit' });
  });

  it('Ctrl-C kills in browse mode', () => {
    expect(keyToAction(key({ name: 'c', ctrl: true }), ui)).toEqual({ type: 'kill' });
  });
});

describe('keyToAction — instruct/answer mode', () => {
  const ui = { mode: 'instruct' as const, input: 'foo', selectedNodeId: 'crew-1' };

  it('printable char appends via inputChar', () => {
    expect(keyToAction(key({ name: 'x', sequence: 'x' }), ui)).toEqual({ type: 'inputChar', ch: 'x' });
  });

  it('backspace drops last char', () => {
    expect(keyToAction(key({ name: 'backspace' }), ui)).toEqual({ type: 'backspace' });
  });

  it('Enter submits', () => {
    expect(keyToAction(key({ name: 'return' }), ui)).toEqual({ type: 'submit' });
  });

  it('Esc cancels', () => {
    expect(keyToAction(key({ name: 'escape' }), ui)).toEqual({ type: 'cancelInput' });
  });

  it('Ctrl-C quits (guard) rather than killing while typing', () => {
    expect(keyToAction(key({ name: 'c', ctrl: true }), ui)).toEqual({ type: 'quit' });
  });
});

describe('applyAction', () => {
  it('move selects the first row when nothing is selected', () => {
    const next = applyAction(initialUi(), { type: 'move', delta: 1 }, rows);
    expect(next.selectedNodeId).toBe('captain');
  });

  it('move clamps at the ends', () => {
    const atEnd = { ...initialUi(), selectedNodeId: 'crew-2' };
    expect(applyAction(atEnd, { type: 'move', delta: 1 }, rows).selectedNodeId).toBe('crew-2');
    const atStart = { ...initialUi(), selectedNodeId: 'captain' };
    expect(applyAction(atStart, { type: 'move', delta: -1 }, rows).selectedNodeId).toBe('captain');
  });

  it('move advances by one row', () => {
    const mid = { ...initialUi(), selectedNodeId: 'captain' };
    expect(applyAction(mid, { type: 'move', delta: 1 }, rows).selectedNodeId).toBe('crew-1');
  });

  it('enterInstruct requires a selection; sets mode and clears input', () => {
    const noSel = initialUi();
    expect(applyAction(noSel, { type: 'enterInstruct' }, rows)).toEqual(noSel);

    const sel = { ...initialUi(), selectedNodeId: 'crew-1', input: 'stale' };
    const next = applyAction(sel, { type: 'enterInstruct' }, rows);
    expect(next.mode).toBe('instruct');
    expect(next.input).toBe('');
    expect(next.selectedNodeId).toBe('crew-1');
  });

  it('enterAnswer requires a selection; sets mode and clears input', () => {
    const sel = { ...initialUi(), selectedNodeId: 'crew-1', input: 'stale' };
    const next = applyAction(sel, { type: 'enterAnswer' }, rows);
    expect(next.mode).toBe('answer');
    expect(next.input).toBe('');
  });

  it('inputChar appends, backspace drops the last char', () => {
    const ui = { mode: 'instruct' as const, input: 'ab', selectedNodeId: 'crew-1' };
    expect(applyAction(ui, { type: 'inputChar', ch: 'c' }, rows).input).toBe('abc');
    expect(applyAction(ui, { type: 'backspace' }, rows).input).toBe('a');
  });

  it('cancelInput returns to browse mode with cleared input', () => {
    const ui = { mode: 'instruct' as const, input: 'draft', selectedNodeId: 'crew-1' };
    const next = applyAction(ui, { type: 'cancelInput' }, rows);
    expect(next).toEqual({ mode: 'browse', input: '', selectedNodeId: 'crew-1' });
  });

  it('submit-timing contract: applyAction on submit resets to browse+empty input; caller must read ui.input BEFORE applying', () => {
    const ui = { mode: 'instruct' as const, input: 'do the thing', selectedNodeId: 'crew-1' };
    // caller reads the text to send BEFORE calling applyAction
    const textToSend = ui.input;
    expect(textToSend).toBe('do the thing');

    const next = applyAction(ui, { type: 'submit' }, rows);
    expect(next.mode).toBe('browse');
    expect(next.input).toBe(''); // cleared AFTER the caller already captured it
  });
});
