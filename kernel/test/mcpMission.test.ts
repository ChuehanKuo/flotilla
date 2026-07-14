import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import type { NodeRef } from '../src/types.js';
import { McpClaudeDriver } from '../src/drivers/mcpClaude.js';
import { PROTOCOL_INSTRUCTIONS } from '../src/protocol.js';
import type { DriverFactoryCtx } from '../src/providers.js';

// M4 integration test: a FULL mission running real McpClaudeDriver instances
// against the mission's own hosted FlotaMcpServer (Mission.start() creates +
// starts it; spawn() registers each claude-code node and threads mcpUrl/token
// into the driver). Both stub CLIs (fake-claude-mcp-captain.mjs,
// fake-claude-mcp-crew.mjs) are REAL MCP clients — every delegate/deliver
// call below is an actual HTTP round trip through the hosted server into
// Mission's own KernelApi, not a mock of any layer in between. This is the
// reliability property M4 exists for: delegation happens via a structured
// tool call the kernel can trust, not by parsing narration text.
const CAPTAIN_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-mcp-captain.mjs');
const CREW_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-mcp-crew.mjs');

function readLog(logFile: string): unknown[][] {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('mcpMission — full mission over real MCP tool calls', () => {
  it('captain delegates twice (delegate tool) -> 2 crew spawn + are ORDER-routed; crew deliver (deliver tool) -> captain resumes -> captain delivers (deliver tool) -> mission completes; no fenced-JSON anywhere', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-mcpmission-'));
    const logFile = join(workspaceDir, 'argv-log.jsonl');
    writeFileSync(logFile, '');
    process.env.FAKE_CLI_LOG = logFile;

    // WHY call order picks the bin, not ref/role: Mission.start() always
    // spawns the captain first (before any delegate can fire), so the driver
    // factory's first invocation is provably the captain and every
    // subsequent one is crew — the same pattern kernel.test.ts uses for its
    // own AiSdkDriver test doubles.
    let calls = 0;
    const driverFactory = (_ref: NodeRef, ctx: DriverFactoryCtx) => {
      calls++;
      const bin = calls === 1 ? CAPTAIN_FIXTURE : CREW_FIXTURE;
      return new McpClaudeDriver({
        workspaceDir: ctx.workspaceDir,
        mcpUrl: ctx.mcpUrl!,
        token: ctx.token!,
        bin,
        onToolEvent: ctx.onToolEvent,
      });
    };

    const mission = new Mission('scan the repo for A and B', defaultConfig(), { driverFactory });

    try {
      const res = await mission.start();

      expect(res.status).toBe('completed');
      expect(res.result).toBe('FINAL: combined scan A + scan B');

      const s = mission.state();
      expect(Object.keys(s.nodes)).toHaveLength(3); // captain + 2 crew
      expect(calls).toBe(3);

      // (a) the reliability property this task exists for: 2 real crew
      // node.spawned events, both parented to the captain, both ORDER-routed
      // — delegation happened via a structured tool call, not parsed text.
      const spawned = mission.log.events.filter(e => e.type === 'node.spawned' && (e.data as any).parentId === 'captain');
      expect(spawned).toHaveLength(2);
      expect(spawned.every(e => (e.data as any).driver === 'claude-code')).toBe(true);
      const ordersFromCaptain = mission.log.events.filter(
        e => e.type === 'message' && (e.data as any).kind === 'ORDER' && (e.data as any).from === 'captain',
      );
      expect(ordersFromCaptain).toHaveLength(2);

      // (b) crew delivered via the real deliver tool (not the kernel's
      // auto-deliver safety net — 'auto' is only set on that fallback path).
      const crewDelivers = mission.log.events.filter(
        e => e.type === 'message' && (e.data as any).kind === 'DELIVER' && (e.data as any).to === 'captain',
      );
      expect(crewDelivers).toHaveLength(2);
      expect(crewDelivers.every(e => (e.data as any).auto === undefined)).toBe(true);

      // (c) captain's own delivery to the operator is likewise a real tool
      // call ending the mission — not auto-deliver.
      const finalDeliver = mission.log.events.find(
        e => e.type === 'message' && (e.data as any).kind === 'DELIVER' && (e.data as any).to === 'operator',
      );
      expect(finalDeliver).toBeDefined();
      expect((finalDeliver!.data as any).auto).toBeUndefined();

      // (d) fenced-JSON is retired for these nodes: PROTOCOL_INSTRUCTIONS
      // never appears in any argv any node was actually invoked with.
      const allArgv = readLog(logFile);
      expect(allArgv.length).toBeGreaterThan(0);
      for (const args of allArgv) {
        for (const arg of args) {
          expect(String(arg)).not.toContain(PROTOCOL_INSTRUCTIONS);
        }
      }

      // (e) the driver's onToolEvent wiring reached the EventLog: real
      // MCP-wire tool_use events for delegate (x2, captain) and deliver (x2,
      // crew) all showed up as their own 'mcp.tool' audit events — 4 minimum.
      // WHY not 5 (the captain's OWN final deliver call is missing here, not
      // asserted): that call is what ends the mission — Mission.finish()
      // aborts every node's abortSignal synchronously the instant it's
      // processed server-side, which SIGTERMs the captain's own still-running
      // CLI subprocess before it can finish printing/parsing its own
      // tool_use/tool_result lines. The mission-level DELIVER message (c,
      // above) is what actually proves that call happened — the mcp.tool
      // trail for a node's own terminal action is inherently best-effort.
      const toolUseEvents = mission.log.events.filter(e => e.type === 'mcp.tool' && (e.data as any).type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(4);
      expect(toolUseEvents.some(e => (e.data as any).name === 'mcp__flota__delegate')).toBe(true);
      expect(toolUseEvents.some(e => (e.data as any).name === 'mcp__flota__deliver')).toBe(true);
      // every tool_use event is tagged with the node that made the call.
      expect(toolUseEvents.every(e => typeof (e.data as any).nodeId === 'string')).toBe(true);
    } finally {
      delete process.env.FAKE_CLI_LOG;
    }
  }, 20_000);
});
