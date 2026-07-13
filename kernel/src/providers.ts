import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelRef, NodeRef } from './types.js';
import type { TurnDriver } from './driver.js';

export type ModelFactory = (ref: ModelRef) => LanguageModel;

export const realModelFactory: ModelFactory = (ref) =>
  ref.provider === 'anthropic' ? anthropic(ref.model) : openai(ref.model);

export type DriverFactory = (ref: NodeRef, ctx: { workspaceDir: string }) => TurnDriver;
