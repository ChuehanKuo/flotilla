import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { Mission, defaultConfig, realModelFactory, AiSdkDriver, type DriverFactory } from '@flotilla/kernel';
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

  // WHY only 'api' refs: subscription-first defaults ship with claude-code/codex
  // crew that never touch an API key; gating on the full crew list would demand
  // ANTHROPIC_API_KEY/OPENAI_API_KEY for missions that never call those SDKs.
  const apiRefs = [config.models.captain, ...config.models.crew].filter(ref => ref.driver === 'api');
  const providersUsed = new Set(apiRefs.map(ref => ref.provider ?? 'anthropic'));
  for (const p of providersUsed) {
    const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (!process.env[key]) { console.error(pc.red(`missing ${key} in environment`)); return 1; }
  }

  // WHY temporary: claude-code/codex drivers land in P3/P4 — until then any
  // non-api ref must fail loudly rather than silently falling through to the
  // AI SDK with the wrong runtime.
  const driverFactory: DriverFactory = (ref) => {
    if (ref.driver !== 'api') throw new Error(`driver not implemented yet: ${ref.driver} (P3/P4)`);
    return new AiSdkDriver(realModelFactory({ provider: ref.provider ?? 'anthropic', model: ref.model ?? config.models.apiDefaults[ref.provider ?? 'anthropic'] }));
  };

  const missionsDir = opts.missionsDir ?? './missions';
  const mission = new Mission(order, config, { driverFactory, missionsDir });
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
