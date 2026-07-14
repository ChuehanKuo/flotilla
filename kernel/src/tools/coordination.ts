import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { DriverKind, FleetMessage, Provider } from '../types.js';

export interface KernelApi {
  delegate(fromNodeId: string, args: { role: string; charter: string; task: string; driver?: DriverKind; provider?: Provider; model?: string }): string;
  emitMessage(msg: Omit<FleetMessage, 'auto'>): void;
}

export interface ToolCtx { nodeId: string; taskId: string; parentId: string; captain: boolean }

export function makeCoordinationTools(ctx: ToolCtx, api: KernelApi): ToolSet {
  const deliver = tool({
    description: 'Deliver your finished work product for your current task. Ends your task.',
    inputSchema: z.object({ text: z.string().describe('the complete work product') }),
    execute: async ({ text }) => {
      api.emitMessage({ kind: 'DELIVER', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text });
      return 'delivered';
    },
  });
  const escalate = tool({
    description: 'Escalate a decision you cannot make yourself. Pauses your task until answered.',
    inputSchema: z.object({ question: z.string() }),
    execute: async ({ question }) => {
      api.emitMessage({ kind: 'ESCALATE', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text: question });
      return 'escalated — you will be woken when answered';
    },
  });

  if (ctx.captain) {
    return {
      delegate: tool({
        description: 'Spawn a crew agent to work a subtask in parallel. Returns immediately; results arrive later as DELIVER messages.',
        inputSchema: z.object({
          role: z.string().describe('short role name, e.g. metrics-scan'),
          charter: z.string().describe('the crew agent\'s role instructions'),
          task: z.string().describe('the concrete task order'),
          driver: z.enum(['api', 'claude-code', 'codex']).optional().describe('runtime for this crew agent; omit for mission default'),
          provider: z.enum(['anthropic', 'openai']).optional().describe('api driver only'),
          model: z.string().optional(),
        }),
        execute: async (args) => api.delegate(ctx.nodeId, args),
      }),
      answer: tool({
        description: 'Answer an escalation from one of your crew, resuming their task.',
        inputSchema: z.object({ taskId: z.string(), text: z.string() }),
        execute: async ({ taskId, text }) => {
          api.emitMessage({ kind: 'ANSWER', from: ctx.nodeId, to: '', taskId, text });
          return 'answered';
        },
      }),
      deliver, escalate,
    };
  }
  return {
    report: tool({
      description: 'Report interim progress upward without ending your task.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        api.emitMessage({ kind: 'REPORT', from: ctx.nodeId, to: ctx.parentId, taskId: ctx.taskId, text });
        return 'reported';
      },
    }),
    deliver, escalate,
  };
}
