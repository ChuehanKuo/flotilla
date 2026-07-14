import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelRef, NodeRef } from './types.js';
import { AiSdkDriver, type TurnDriver } from './driver.js';
import { ClaudeCodeDriver } from './drivers/claudeCode.js';
import { CodexDriver } from './drivers/codex.js';

export type ModelFactory = (ref: ModelRef) => LanguageModel;

export const realModelFactory: ModelFactory = (ref) =>
  ref.provider === 'anthropic' ? anthropic(ref.model) : openai(ref.model);

export type DriverFactory = (ref: NodeRef, ctx: { workspaceDir: string }) => TurnDriver;

// WHY ref.model ?? 'unset' here rather than resolving apiDefaults inline: the
// crew path already gets its model resolved by kernel's delegate() before the
// ref reaches this factory; the captain ref (spawned directly from config, not
// via delegate) must be pre-resolved by the caller (see cli/src/run.ts) — this
// factory is a pure driver-construction seam, not a config-resolution point.
export const realDriverFactory: DriverFactory = (ref, ctx) => {
  if (ref.driver === 'claude-code') return new ClaudeCodeDriver({ workspaceDir: ctx.workspaceDir });
  if (ref.driver === 'codex') return new CodexDriver({ workspaceDir: ctx.workspaceDir });
  const provider = ref.provider ?? 'anthropic';
  return new AiSdkDriver(realModelFactory({ provider, model: ref.model ?? 'unset' }));
};
