import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelRef, NodeRef } from './types.js';
import { AiSdkDriver, type TurnDriver } from './driver.js';
import { CliDriver } from './drivers/cliDriver.js';
import { McpClaudeDriver, type McpToolEvent } from './drivers/mcpClaude.js';
import { McpCodexDriver } from './drivers/mcpCodex.js';

export type ModelFactory = (ref: ModelRef) => LanguageModel;

export const realModelFactory: ModelFactory = (ref) =>
  ref.provider === 'anthropic' ? anthropic(ref.model) : openai(ref.model);

// WHY mcpUrl/token/onToolEvent are optional here (not split into a separate
// MCP-only ctx type): DriverFactory is one seam shared by every driver kind —
// 'api'/'custom' never read them, 'claude-code'/'codex' require them at
// runtime (the mission that supplies ctx always registers those nodes with
// its hosted FlotaMcpServer first). A discriminated-union ctx would force
// every caller (tests included) to prove which branch they're in before they
// can even construct the ctx object.
export interface DriverFactoryCtx {
  workspaceDir: string;
  mcpUrl?: string;
  token?: string;
  onToolEvent?: (event: McpToolEvent) => void;
}

export type DriverFactory = (ref: NodeRef, ctx: DriverFactoryCtx) => TurnDriver;

// WHY ref.model ?? 'unset' here rather than resolving apiDefaults inline: the
// crew path already gets its model resolved by kernel's delegate() before the
// ref reaches this factory; the captain ref (spawned directly from config, not
// via delegate) must be pre-resolved by the caller (see cli/src/run.ts) — this
// factory is a pure driver-construction seam, not a config-resolution point.
//
// WHY claude-code/codex route to the Mcp* drivers now, not ClaudeCodeDriver/
// CodexDriver: M4 retires the fenced-JSON protocol for these driver kinds —
// every claude-code/codex node talks to the mission's hosted FlotaMcpServer
// over real MCP tool calls instead. ClaudeCodeDriver/CodexDriver (and
// PROTOCOL_INSTRUCTIONS/formatTurnPrompt, which they use internally via
// CliDriver+CLAUDE_CODE_SPEC/CODEX_SPEC) stay in the tree — still reachable
// via driver:'custom' with a hand-built CliDriverSpec — but are no longer
// wired to these two driver kinds by default.
export const realDriverFactory: DriverFactory = (ref, ctx) => {
  if (ref.driver === 'claude-code') {
    if (!ctx.mcpUrl || !ctx.token) throw new Error('claude-code driver requires mcpUrl/token — the mission must register this node with its MCP server first');
    return new McpClaudeDriver({ workspaceDir: ctx.workspaceDir, mcpUrl: ctx.mcpUrl, token: ctx.token, onToolEvent: ctx.onToolEvent });
  }
  if (ref.driver === 'codex') {
    if (!ctx.mcpUrl || !ctx.token) throw new Error('codex driver requires mcpUrl/token — the mission must register this node with its MCP server first');
    return new McpCodexDriver({ workspaceDir: ctx.workspaceDir, mcpUrl: ctx.mcpUrl, token: ctx.token });
  }
  if (ref.driver === 'custom') {
    if (!ref.spec) throw new Error('custom driver requires a spec');
    return new CliDriver(ref.spec, { workspaceDir: ctx.workspaceDir });
  }
  const provider = ref.provider ?? 'anthropic';
  return new AiSdkDriver(realModelFactory({ provider, model: ref.model ?? 'unset' }));
};
