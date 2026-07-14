import { MockLanguageModelV2 } from 'ai/test';
import { defaultConfig, type MissionConfig } from '../src/types.js';

// WHY this exists (post-M4): defaultConfig()'s captain/crew both default to
// driver:'claude-code' — a real production default — which the kernel now
// registers with the mission's hosted MCP server and gives an EMPTY tool set
// (native AI-SDK tools are retired for that driver kind; see kernel.ts
// spawn()'s isMcpNode branch). Kernel-mechanics tests below don't want to
// spawn a real `claude` CLI — they drive missions through a fake driverFactory
// that always returns an AiSdkDriver test double, which only works when the
// node's declared ref is 'api' (so it actually receives delegate/deliver/
// escalate/report/answer as callable tools). apiConfig() is that config: same
// defaults as defaultConfig(), captain+crew swapped to 'api'.
export function apiConfig(): MissionConfig {
  const cfg = defaultConfig();
  const apiRef = { driver: 'api' as const, provider: 'anthropic' as const, model: 'claude-sonnet-5' };
  return { ...cfg, models: { captain: { ...apiRef }, crew: [{ ...apiRef }, { ...apiRef }], apiDefaults: cfg.models.apiDefaults } };
}

/**
 * Scripted mock: outer array = successive doGenerate calls; each entry is the
 * content the model "responds" with — either a tool call or plain text.
 */
export function scriptedModel(calls: Array<{ toolName?: string; input?: object; text?: string }>): MockLanguageModelV2 {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      const step = calls[Math.min(i++, calls.length - 1)];
      const content = step.toolName
        ? [{ type: 'tool-call' as const, toolCallId: `call-${i}`, toolName: step.toolName, input: JSON.stringify(step.input ?? {}) }]
        : [{ type: 'text' as const, text: step.text ?? '' }];
      return {
        finishReason: step.toolName ? ('tool-calls' as const) : ('stop' as const),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        content,
        warnings: [],
      };
    },
  });
}

export function failingThenTextModel(failures: number, text: string): MockLanguageModelV2 {
  let n = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      if (n++ < failures) throw new Error('simulated API error');
      return {
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        content: [{ type: 'text' as const, text }],
        warnings: [],
      };
    },
  });
}
