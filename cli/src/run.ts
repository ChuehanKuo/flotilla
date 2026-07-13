import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { Mission, defaultConfig, realModelFactory } from '@flotilla/kernel';
import { formatEvent } from './render.js';

export async function runMission(order: string, opts: { budget?: string; missionsDir?: string }): Promise<number> {
  const config = defaultConfig();
  if (opts.budget) config.budgetUsd = Number(opts.budget);

  const providersUsed = new Set([config.models.captain.provider, ...config.models.crew.map(c => c.provider)]);
  for (const p of providersUsed) {
    const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (!process.env[key]) { console.error(pc.red(`missing ${key} in environment`)); return 1; }
  }

  const mission = new Mission(order, config, { modelFactory: realModelFactory, missionsDir: opts.missionsDir ?? './missions' });
  mission.log.subscribe(e => { const line = formatEvent(e); if (line) console.log(line); });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  mission.onOperatorEscalation(async (e) => {
    const answer = await rl.question(pc.yellow(`\n⚠ ${e.from} asks: ${e.text}\nyour answer> `));
    mission.answerEscalation(e.taskId, answer);
  });
  process.on('SIGINT', () => mission.cancel('operator kill (SIGINT)'));

  const result = await mission.start();
  rl.close();
  if (result.status === 'completed') {
    console.log('\n' + pc.bold('── DELIVERABLE ──────────────────────'));
    console.log(result.result);
    console.log(pc.dim(`\ntotal cost: $${result.totalCostUsd.toFixed(2)} · log: missions/${mission.id}/events.jsonl`));
    return 0;
  }
  console.error(pc.red(`mission ${result.status}: ${result.reason ?? ''} (spent $${result.totalCostUsd.toFixed(2)})`));
  return 1;
}
