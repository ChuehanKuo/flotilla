import { describe, it, expect } from 'vitest';
import { realModelFactory } from '../src/providers.js';

describe('realModelFactory', () => {
  it('resolves both providers to model instances carrying the model id', () => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key';
    process.env.OPENAI_API_KEY ??= 'test-key';
    const a = realModelFactory({ provider: 'anthropic', model: 'claude-sonnet-5' });
    const o = realModelFactory({ provider: 'openai', model: 'gpt-5.6-sol' });
    // WHY the cast: `LanguageModel` from 'ai' is a union with GlobalProviderModelId
    // (gateway string ids), so TS won't narrow `.modelId` on the union — but the runtime
    // value here is always a LanguageModelV2 instance from anthropic()/openai().
    expect((a as { modelId: string }).modelId).toBe('claude-sonnet-5');
    expect((o as { modelId: string }).modelId).toBe('gpt-5.6-sol');
  });
});
