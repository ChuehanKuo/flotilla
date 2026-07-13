import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelRef } from './types.js';

export type ModelFactory = (ref: ModelRef) => LanguageModel;

export const realModelFactory: ModelFactory = (ref) =>
  ref.provider === 'anthropic' ? anthropic(ref.model) : openai(ref.model);
