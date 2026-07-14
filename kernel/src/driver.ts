import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';

export interface TurnInput {
  system: string;
  newText: string;                    // this turn's incoming batch, formatted
  transcript: ModelMessage[];         // full history incl. the new user message (api driver)
  tools: ToolSet;
  maxSteps: number;
  abortSignal: AbortSignal;
}

export interface TurnOutput {
  text: string;
  responseMessages: ModelMessage[];   // [] for CLI drivers
  usage: { inputTokens: number; outputTokens: number };
  billing: 'api' | 'subscription';
}

export interface TurnDriver { turn(input: TurnInput): Promise<TurnOutput> }

export class AiSdkDriver implements TurnDriver {
  constructor(private model: LanguageModel) {}

  async turn(input: TurnInput): Promise<TurnOutput> {
    const result = await generateText({
      model: this.model,
      system: input.system,
      messages: input.transcript,
      tools: input.tools,
      stopWhen: stepCountIs(input.maxSteps),
      abortSignal: input.abortSignal,
    });
    return {
      text: result.text,
      responseMessages: result.response.messages,
      usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
      billing: 'api',
    };
  }
}
