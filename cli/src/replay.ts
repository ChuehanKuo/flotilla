import { createInterface } from 'node:readline/promises';
import { EventLog } from '@flotilla/kernel';
import { formatEvent } from './render.js';

export async function replay(eventsFile: string, opts: { step?: boolean }, out?: (line: string) => void): Promise<void> {
  const events = EventLog.load(eventsFile);
  const print = out ?? console.log;
  const rl = opts.step && !out ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  for (const e of events) {
    // WHY the try/catch: replay feeds formatEvent arbitrary events.jsonl content
    // (hand-edited or truncated files); one malformed record must not kill the replay.
    let line: string | null;
    try { line = formatEvent(e); }
    catch { line = `⚠ malformed event (seq ${(e as { seq?: number }).seq ?? '?'})`; }
    if (!line) continue;
    print(line);
    if (rl) await rl.question('');
  }
  rl?.close();
}
