import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import type { MissionConfig, NodeRef } from '../src/types.js';
import { AiSdkDriver, type TurnDriver, type TurnInput, type TurnOutput } from '../src/driver.js';
import { McpCodexDriver } from '../src/drivers/mcpCodex.js';
import type { DriverFactoryCtx } from '../src/providers.js';
import { scriptedModel } from './helpers.js';

const FIXTURE_CODEX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.sh');

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0.0.1' } },
});

// A driver that acts as an MCP client in-process (no subprocess): each turn it
// connects with its node's token and runs a scripted action against the
// mission's own hosted server — the real KernelApi fires exactly as a real CLI
// node's tool call would. Used to drive terminal-node token revocation without
// the weight of a stub CLI round-trip.
class McpActionDriver implements TurnDriver {
  private turns = 0;
  constructor(private opts: { mcpUrl: string; token: string; action: (client: Client, turn: number) => Promise<string> }) {}
  async turn(_input: TurnInput): Promise<TurnOutput> {
    this.turns++;
    const client = new Client({ name: 'action', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
    });
    await client.connect(transport);
    const text = await this.opts.action(client, this.turns);
    await client.close();
    return { text, responseMessages: [], usage: { inputTokens: 0, outputTokens: 0 }, billing: 'subscription' };
  }
}

function codexConfig(): MissionConfig {
  const cfg = defaultConfig();
  return { ...cfg, models: { captain: { driver: 'codex' }, crew: [{ driver: 'codex' }], apiDefaults: cfg.models.apiDefaults } };
}

describe('MCP mission lifecycle', () => {
  afterEach(() => {
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_REPLY;
  });

  it('finish() disposes each codex node driver — the per-mission CODEX_HOME is gone after the mission ends', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'flota-codexlife-'));
    const logFile = join(workspaceDir, 'log.jsonl');
    const replyFile = join(workspaceDir, 'reply.jsonl');
    writeFileSync(logFile, '');
    writeFileSync(replyFile, [{ type: 'session_started', session_id: 'sess-1' }, { type: 'agent_message', text: 'done' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_REPLY = replyFile;

    let codexDriver: McpCodexDriver | undefined;
    const driverFactory = (_ref: NodeRef, ctx: DriverFactoryCtx) => {
      const d = new McpCodexDriver({ workspaceDir: ctx.workspaceDir, mcpUrl: ctx.mcpUrl!, token: ctx.token!, bin: FIXTURE_CODEX });
      codexDriver = d;
      return d;
    };

    const mission = new Mission('x', codexConfig(), { driverFactory });
    const res = await mission.start();

    expect(res.status).toBe('completed'); // captain's stub text auto-delivers
    expect(codexDriver).toBeDefined();
    // The leak M4 introduced (McpCodexDriver on the default path, cleanup()
    // never called) is now closed: finish() swept the driver and rm'd its home.
    expect(existsSync(codexDriver!.codexHome)).toBe(false);
  });

  it('a synchronous cancel() in the same tick as start() resolves (no hang), never spawns the captain, never logs mission.started', async () => {
    let factoryCalled = false;
    const driverFactory = () => { factoryCalled = true; return new AiSdkDriver(scriptedModel([{ text: '' }])); };
    const mission = new Mission('x', defaultConfig(), { driverFactory });

    const p = mission.start();
    mission.cancel('early kill'); // same tick, before the server-start await settles

    const res = await p; // must NOT hang
    expect(res.status).toBe('canceled');
    expect(res.reason).toBe('early kill');
    expect(mission.state().status).toBe('canceled');
    expect(factoryCalled).toBe(false); // captain never spawned into a dead mission
    expect(mission.log.events.some(e => e.type === 'mission.started')).toBe(false);
    // mission.canceled is the ONLY lifecycle event — no started-after-canceled.
    expect(mission.log.events.map(e => e.type)).toEqual(['mission.canceled']);
  });

  it("revokes a crew node's MCP token the instant its task completes — a later call with that token gets 401 while the mission is still running", async () => {
    let captainToken = '', crewToken = '', mcpUrl = '';
    let calls = 0;

    const captainAction = async (client: Client, turn: number): Promise<string> => {
      if (turn === 1) {
        await client.callTool({ name: 'delegate', arguments: { role: 'w', charter: 'c', task: 't' } });
        return 'delegated'; // open child -> captain won't auto-deliver, mission stays alive
      }
      return ''; // resumed by the crew DELIVER; empty -> no auto-deliver, stays working
    };
    const crewAction = async (client: Client): Promise<string> => {
      await client.callTool({ name: 'deliver', arguments: { text: 'crew done' } });
      return 'delivered';
    };

    const driverFactory = (_ref: NodeRef, ctx: DriverFactoryCtx) => {
      calls++;
      mcpUrl = ctx.mcpUrl!;
      if (calls === 1) { captainToken = ctx.token!; return new McpActionDriver({ mcpUrl: ctx.mcpUrl!, token: ctx.token!, action: captainAction }); }
      crewToken = ctx.token!;
      return new McpActionDriver({ mcpUrl: ctx.mcpUrl!, token: ctx.token!, action: crewAction });
    };

    const mission = new Mission('x', defaultConfig(), { driverFactory }); // captain+crew default to claude-code -> MCP nodes
    const resultPromise = mission.start();

    // Wait until the crew's task (t2) is completed — the token-revoking transition.
    for (let i = 0; i < 200 && mission.state().tasks['t2']?.state !== 'completed'; i++) await sleep(10);
    expect(mission.state().tasks['t2'].state).toBe('completed');
    expect(mission.state().status).toBe('running'); // mission itself still alive
    expect(crewToken.length).toBeGreaterThan(0);

    // The crew's still-valid-looking token is now dead: a fresh MCP request
    // with it is rejected 401 (unregisterNode fired on the terminal task).
    const revoked = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${crewToken}` },
      body: INIT_BODY,
    });
    expect(revoked.status).toBe(401);

    // Control: the captain's token (task still working) is NOT revoked.
    const live = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${captainToken}` },
      body: INIT_BODY,
    });
    expect(live.status).not.toBe(401);

    mission.cancel('test done');
    await resultPromise;
  });
});
