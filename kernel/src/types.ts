export type Provider = 'anthropic' | 'openai';
export type DriverKind = 'api' | 'claude-code' | 'codex';

export type TaskState =
  | 'submitted' | 'working' | 'input-required'
  | 'completed' | 'failed' | 'canceled' | 'rejected';

export type MessageKind = 'ORDER' | 'REPORT' | 'DELIVER' | 'ESCALATE' | 'ANSWER';

export interface FleetMessage {
  kind: MessageKind;
  from: string;           // nodeId or 'operator'
  to: string;             // nodeId or 'operator'
  taskId: string;
  parentTaskId?: string;
  text: string;
  auto?: boolean;         // true when kernel auto-delivered a node's final text
}

export type EventType =
  | 'mission.started' | 'node.spawned' | 'message' | 'task.state'
  | 'tool.called' | 'usage' | 'watchdog'
  | 'mission.completed' | 'mission.canceled' | 'mission.failed';

export interface FleetEvent {
  eventId: string;
  seq: number;
  ts: string;             // ISO 8601
  missionId: string;
  type: EventType;
  data: Record<string, unknown>;
}

export interface ModelRef { provider: Provider; model: string }
export interface NodeRef { driver: DriverKind; provider?: Provider; model?: string }

export interface MissionConfig {
  budgetUsd: number;
  maxDepth: number;
  maxChildren: number;
  maxConcurrentNodes: number;
  watchdogMs: number;
  missionTimeoutMs: number;
  maxStepsPerTurn: number;
  maxTurnsPerNode: number;
  models: { captain: NodeRef; crew: NodeRef[]; apiDefaults: Record<Provider, string> };
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

// WHY these model ids/prices: verified current at Task 13 review (2026-07-14)
// against platform.claude.com (Claude Sonnet 5) and developers.openai.com (GPT-5.6 Sol);
// they live in config, not code, so future drift can be corrected without a code change.
export function defaultConfig(): MissionConfig {
  return {
    budgetUsd: 5,
    maxDepth: 2,
    maxChildren: 5,
    maxConcurrentNodes: 8,
    watchdogMs: 600_000,
    missionTimeoutMs: 1_800_000,
    maxStepsPerTurn: 12,
    maxTurnsPerNode: 20,
    models: {
      captain: { driver: 'claude-code' },
      // WHY both default crew are claude-code (v0.1): the codex driver is EXPERIMENTAL
      // — it hung on live contact (unverified real `codex exec --json` shape / sandbox
      // interaction) where claude-code has run reliably. codex stays in the tree and is
      // opt-in per-node via a delegate's driver arg or a hand-built config; hardening it
      // against the live CLI is a v0.2 item. Two slots keeps captain parallelism.
      crew: [
        { driver: 'claude-code' },
        { driver: 'claude-code' },
      ],
      apiDefaults: { anthropic: 'claude-sonnet-5', openai: 'gpt-5.6-sol' },
    },
    pricing: {
      'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
      'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30 },
    },
  };
}
