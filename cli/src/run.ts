import { createInterface } from 'node:readline/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { Mission, defaultConfig, realDriverFactory } from '@flotilla/kernel';
import { formatEvent } from './render.js';

const execFile = promisify(execFileCb);

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

  // WHY here, not in realDriverFactory: kernel's delegate() already resolves an
  // api ref's model from apiDefaults for crew spawned via the tool; the captain
  // ref comes straight from config and is spawned directly (Mission.start()),
  // bypassing that resolution — an api captain with no explicit model must be
  // given one before realDriverFactory ever sees the ref.
  if (config.models.captain.driver === 'api' && !config.models.captain.model) {
    const provider = config.models.captain.provider ?? 'anthropic';
    config.models.captain.model = config.models.apiDefaults[provider];
  }

  // Preflight: gate on whatever driver kinds this run's config actually uses —
  // 'api' needs its provider's key in env, 'claude-code'/'codex' need the CLI
  // itself present and working (a missing/broken CLI would otherwise surface
  // as a confusing execFile ENOENT deep inside the first node's first turn).
  const kindsUsed = new Set([config.models.captain, ...config.models.crew].map(ref => ref.driver));

  if (kindsUsed.has('api')) {
    // WHY only 'api' refs: subscription-first defaults ship with claude-code/codex
    // crew that never touch an API key; gating on the full crew list would demand
    // ANTHROPIC_API_KEY/OPENAI_API_KEY for missions that never call those SDKs.
    const apiRefs = [config.models.captain, ...config.models.crew].filter(ref => ref.driver === 'api');
    const providersUsed = new Set(apiRefs.map(ref => ref.provider ?? 'anthropic'));
    for (const p of providersUsed) {
      const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      if (!process.env[key]) { console.error(pc.red(`missing ${key} in environment`)); return 1; }
    }
  }
  if (kindsUsed.has('claude-code')) {
    try { await execFile('claude', ['--version'], { timeout: 10_000 }); }
    catch (err: any) {
      const timedOut = err?.killed ? ' (timed out)' : '';
      console.error(pc.red(`'claude' CLI not found or not working${timedOut} — install Claude Code and sign in, or switch this node's driver to 'api'`));
      return 1;
    }
  }
  if (kindsUsed.has('codex')) {
    try { await execFile('codex', ['--version'], { timeout: 10_000 }); }
    catch (err: any) {
      const timedOut = err?.killed ? ' (timed out)' : '';
      console.error(pc.red(`'codex' CLI not found or not working${timedOut} — install the Codex CLI and sign in, or switch this node's driver to 'api'`));
      return 1;
    }
  }

  const missionsDir = opts.missionsDir ?? './missions';
  const mission = new Mission(order, config, { driverFactory: realDriverFactory, missionsDir });
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
