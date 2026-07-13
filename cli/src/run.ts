import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { Mission, defaultConfig, realModelFactory } from '@flotilla/kernel';
import { formatEvent } from './render.js';

export async function runMission(order: string, opts: { budget?: string; missionsDir?: string }): Promise<number> {
  const config = defaultConfig();
  if (opts.budget !== undefined) {
    const cap = Number(opts.budget);
    // WHY the isFinite gate: Number('abc') is NaN, and `total >= NaN` is always
    // false — an unvalidated --budget would silently disable the hard cap.
    if (!Number.isFinite(cap) || cap <= 0) {
      console.error(pc.red(`--budget must be a positive number, got '${opts.budget}'`));
      return 1;
    }
    config.budgetUsd = cap;
  }

  const providersUsed = new Set([config.models.captain.provider, ...config.models.crew.map(c => c.provider)]);
  for (const p of providersUsed) {
    const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (!process.env[key]) { console.error(pc.red(`missing ${key} in environment`)); return 1; }
  }

  const missionsDir = opts.missionsDir ?? './missions';
  const mission = new Mission(order, config, { modelFactory: realModelFactory, missionsDir });
  mission.log.subscribe(e => { const line = formatEvent(e); if (line) console.log(line); });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // WHY the queue: readline drops a second question() registered while one is
  // pending — concurrent escalations would silently lose every answer but the
  // first. Serializing through a promise chain guarantees each gets its turn.
  let promptChain: Promise<void> = Promise.resolve();
  mission.onOperatorEscalation((e) => {
    promptChain = promptChain.then(async () => {
      try {
        const answer = await rl.question(pc.yellow(`\n⚠ ${e.from} asks: ${e.text}\nyour answer> `));
        mission.answerEscalation(e.taskId, answer);
      } catch { /* readline closed mid-question (mission ended) — nothing left to answer */ }
    });
  });
  // WHY both hooks: on a TTY, readline owns stdin and delivers Ctrl-C as an
  // rl 'SIGINT' event, not a process signal; the process hook still covers
  // non-TTY stdin and external `kill -INT`.
  rl.on('SIGINT', () => mission.cancel('operator kill (Ctrl-C)'));
  process.on('SIGINT', () => mission.cancel('operator kill (SIGINT)'));

  const result = await mission.start();
  rl.close();
  if (result.status === 'completed') {
    console.log('\n' + pc.bold('── DELIVERABLE ──────────────────────'));
    console.log(result.result);
    console.log(pc.dim(`\ntotal cost: $${result.totalCostUsd.toFixed(2)} · log: ${missionsDir}/${mission.id}/events.jsonl`));
    return 0;
  }
  console.error(pc.red(`mission ${result.status}: ${result.reason ?? ''} (spent $${result.totalCostUsd.toFixed(2)})`));
  return 1;
}
