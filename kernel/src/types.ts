export type Provider = 'anthropic' | 'openai';

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

export interface MissionConfig {
  budgetUsd: number;
  maxDepth: number;
  maxChildren: number;
  maxConcurrentNodes: number;
  watchdogMs: number;
  missionTimeoutMs: number;
  maxStepsPerTurn: number;
  models: { captain: ModelRef; crew: ModelRef[] };
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

// WHY these model ids/prices: current defaults at design time (2026-07);
// they live in config, not code, so Task 13 can correct them without a code change.
export function defaultConfig(): MissionConfig {
  return {
    budgetUsd: 5,
    maxDepth: 2,
    maxChildren: 5,
    maxConcurrentNodes: 8,
    watchdogMs: 300_000,
    missionTimeoutMs: 1_800_000,
    maxStepsPerTurn: 12,
    models: {
      captain: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      crew: [
        { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        { provider: 'openai', model: 'gpt-5.1' },
      ],
    },
    pricing: {
      'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
      'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
    },
  };
}
