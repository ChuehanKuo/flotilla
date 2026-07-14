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
    // WHY not `await mission.start()` before waitUntilExit: the TUI itself
    // unmounts (App.tsx's terminal-state effect) once the mission leaves
    // 'running', which only happens after the log event that settles this
    // promise has already been appended — so resultPromise is guaranteed
    // settled by the time waitUntilExit() resolves, in either race order.
    const resultPromise = mission.start();
    await app.waitUntilExit();
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
