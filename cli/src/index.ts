#!/usr/bin/env tsx
import { Command } from 'commander';
import { runMission } from './run.js';
import { replay } from './replay.js';

const program = new Command('flotilla');
program.command('run <order>')
  .description('run a mission: a captain decomposes your order across crew agents')
  .option('--budget <usd>', 'hard mission budget cap in USD')
  .option('--missions-dir <path>', 'where mission logs/workspaces live')
  .action(async (order, opts) => { process.exitCode = await runMission(order, opts); });
program.command('replay <eventsFile>')
  .description('re-render a past mission log; --step to advance per keypress')
  .option('--step', 'wait for Enter between events')
  .action(async (file, opts) => { await replay(file, opts); });
program.parseAsync();
