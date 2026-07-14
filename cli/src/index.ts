#!/usr/bin/env tsx
import { Command } from 'commander';
import pc from 'picocolors';
import { renderFleet } from '@flota/tui';
import { buildMission, runMission } from './run.js';
import { replay } from './replay.js';
import { watch } from './watch.js';

const program = new Command('flota');
program.command('run <order>')
  .description('run a mission: a captain decomposes your order across crew agents')
  .option('--budget <usd>', 'hard mission budget cap in USD')
  .option('--missions-dir <path>', 'where mission logs/workspaces live')
  .option('--headless', 'plain line-tail output (v0.1 behavior) instead of the full-screen TUI')
  .action(async (order, opts) => {
    if (opts.headless) { process.exitCode = await runMission(order, opts); return; }

    const built = await buildMission(order, opts);
    if (!built) { process.exitCode = 1; return; }
    const { mission, missionsDir } = built;

    const app = renderFleet(mission);
    const resultPromise = mission.start();
    await app.waitUntilExit();

    // The TUI can exit two ways: the mission reached a terminal state (App's
    // exit effect fired — resultPromise is already settled), OR the operator
    // quit while the mission was still running (`q`). In the latter case,
    // closing mission control stops the fleet — otherwise `await resultPromise`
    // would block on a mission with no input surface left (a pending escalation
    // deadlocks; and since the kernel's timers are unref'd, the process could
    // even exit mid-mission with nothing printed). Cancel first, THEN await —
    // cancel() settles resultPromise, so the await always resolves.
    if (mission.state().status === 'running') mission.cancel('operator closed TUI');
    const result = await resultPromise;

    if (result.status === 'completed') {
      console.log('\n' + pc.bold('── DELIVERABLE ──────────────────────'));
      console.log(result.result);
      console.log(pc.dim(`\ntotal cost: $${result.totalCostUsd.toFixed(2)} · log: ${missionsDir}/${mission.id}/events.jsonl`));
      process.exitCode = 0;
    } else {
      console.error(pc.red(`mission ${result.status}: ${result.reason ?? ''} (spent $${result.totalCostUsd.toFixed(2)})`));
      process.exitCode = 1;
    }
  });
program.command('replay <eventsFile>')
  .description('re-render a past mission log; --step to advance per keypress')
  .option('--step', 'wait for Enter between events')
  .action(async (file, opts) => { await replay(file, opts); });
program.command('watch <target>')
  .description('watch a mission log (events.jsonl or its mission dir); replays a completed run')
  .option('--step', 'wait for Enter between events')
  .action(async (target, opts) => { process.exitCode = await watch(target, opts); });
program.parseAsync();
