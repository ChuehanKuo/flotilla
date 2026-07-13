import { MockLanguageModelV2 } from 'ai/test';

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
