import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { EventLog } from '@flota/kernel';
import { replay } from './replay.js';

const TERMINAL_EVENT_TYPES = new Set(['mission.completed', 'mission.canceled', 'mission.failed']);

// v0.2 scope (per brief): read-only replay of a COMPLETED mission's log, from
// either the events.jsonl file itself or its mission directory. Live attach to
// an in-progress mission (tailing events.jsonl as it grows) is a real feature
// but adds a second, currently-unbuilt read path into Mission/EventLog state —
// scoped out as a v0.2-later follow-up rather than built here; `flota run`
// (without --headless) already shows a mission live in the TUI as it happens.
export async function watch(target: string, opts: { step?: boolean }): Promise<number> {
  if (!existsSync(target)) {
    console.error(pc.red(`no such file or mission directory: ${target}`));
    return 1;
  }
  const file = statSync(target).isDirectory() ? join(target, 'events.jsonl') : target;
  if (!existsSync(file)) {
    console.error(pc.red(`no events log found at ${file}`));
    return 1;
  }

  const events = EventLog.load(file);
  const last = events[events.length - 1];
  if (!last || !TERMINAL_EVENT_TYPES.has(last.type)) {
    console.error(pc.yellow(
      `mission at ${file} looks still in progress — live read-only attach isn't wired up yet ` +
      `(v0.2 follow-up). Watch it live instead with 'flota run', or re-run 'watch' once it finishes.`
    ));
    return 1;
  }

  await replay(file, opts);
  return 0;
}
