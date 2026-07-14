import { createElement } from 'react';
import { render } from 'ink';
import type { Mission } from '@flota/kernel';
import { App } from './App.js';

export function renderFleet(mission: Mission): { waitUntilExit(): Promise<void> } {
  // WHY exitOnCtrlC: false — Ink's default intercepts Ctrl-C before useInput
  // even sees it and unmounts unconditionally. keymap.ts's contract routes
  // Ctrl-C to 'kill' (browse mode) or 'quit' (composing) instead; App.tsx
  // unmounts itself once the mission reaches a terminal state.
  const instance = render(createElement(App, { mission }), { exitOnCtrlC: false });
  return { waitUntilExit: () => instance.waitUntilExit() };
}
