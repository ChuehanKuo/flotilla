#!/usr/bin/env node
// Crew-side stub for mcpMission.test.ts — the counterpart to
// fake-claude-mcp-captain.mjs. A crew node only ever needs one turn: round-
// trip a REAL `deliver` call through the mission's hosted FlotaMcpServer
// (proving the crew's own token/role-gating works, not just the captain's)
// and end its own task. Never resumed in this test (once delivered, the
// task is terminal and the kernel never routes another ORDER to this node).
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(args) + '\n');
}

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const mcpConfig = JSON.parse(flagValue('--mcp-config'));
const flota = mcpConfig.mcpServers.flota;
const token = (flota.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
const promptText = args[1]; // args = ['-p', promptText, ...]
const SESSION_ID = `sess-crew-mcp-${Math.random().toString(36).slice(2)}`;

async function main() {
  const client = new Client({ name: 'fake-claude-mcp-crew', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(flota.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  const toolUseId = 'toolu_crew_deliver';
  const deliverArgs = { text: `result for: ${promptText}` };
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__flota__deliver', input: deliverArgs }] },
    session_id: SESSION_ID,
  }));

  const result = await client.callTool({ name: 'deliver', arguments: deliverArgs });
  const resultText = result.content?.[0]?.text ?? '';
  console.log(JSON.stringify({
    type: 'user',
    message: { content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: resultText }] }] },
    tool_use_result: [{ type: 'text', text: resultText }],
  }));

  const finalText = 'delivered';
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: finalText }] }, session_id: SESSION_ID }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: finalText, session_id: SESSION_ID, usage: { input_tokens: 5, output_tokens: 3 } }));

  await client.close();
}

main().catch(err => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
