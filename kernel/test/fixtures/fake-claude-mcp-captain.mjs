#!/usr/bin/env node
// Captain-side stub for mcpMission.test.ts. Like fake-claude-mcp.mjs, this
// ACTUALLY round-trips through the mission's real (test-hosted) FlotaMcpServer
// — it never fakes a tool result. Unlike fake-claude-mcp.mjs (a single fixed
// delegate call), this stub plays a small script across turns so a full
// mission (captain delegates twice -> both crew deliver -> captain delivers)
// can run end to end against real McpClaudeDriver instances:
//
//   turn 1 (no --resume): calls delegate TWICE, for two distinct crew, then
//     ends with plain narration text (no deliver — crew work is still open).
//   turn 2+ (--resume): counts how many "[DELIVER from" lines are in THIS
//     turn's prompt (node.ts batches all pending messages into one newText
//     per turn — could be 1 or both crew DELIVERs, depending on how the two
//     crew subprocesses race) and adds that to a running total persisted in
//     a state file scoped to this node's CWD (== the mission's shared
//     workspaceDir, but only the captain script ever writes this file, so no
//     cross-node collision). Once the running total reaches 2 (both crew
//     delivered, in this turn or an earlier one), calls deliver with the
//     mission's final result. Otherwise just narrates and waits for the next
//     resume.
//
// Appends argv to $FAKE_CLI_LOG (same convention as every other fixture here)
// so the test can assert no PROTOCOL_INSTRUCTIONS ever appears in what this
// node was invoked with.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const isResume = args.includes('--resume');
const promptText = args[1]; // args = ['-p', promptText, ...]

const SESSION_ID = 'sess-captain-mcp-1';
const STATE_FILE = join(process.cwd(), '.captain-mcp-state.json');

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { delivered: 0 }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s)); }

function assistantText(text) {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: SESSION_ID }));
}
function resultEvent(text) {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: text, session_id: SESSION_ID, usage: { input_tokens: 10, output_tokens: 5 } }));
}

async function callTool(client, toolUseId, name, toolArgs) {
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: `mcp__flota__${name}`, input: toolArgs }] },
    session_id: SESSION_ID,
  }));
  const result = await client.callTool({ name, arguments: toolArgs });
  const text = result.content?.[0]?.text ?? '';
  console.log(JSON.stringify({
    type: 'user',
    message: { content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] }] },
    tool_use_result: [{ type: 'text', text }],
  }));
  return text;
}

async function main() {
  const client = new Client({ name: 'fake-claude-mcp-captain', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(flota.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  if (!isResume) {
    await callTool(client, 'toolu_captain_1', 'delegate', { role: 'scan-a', charter: 'Scan A.', task: 'scan A' });
    await callTool(client, 'toolu_captain_2', 'delegate', { role: 'scan-b', charter: 'Scan B.', task: 'scan B' });
    const text = 'awaiting crew';
    assistantText(text);
    resultEvent(text);
    await client.close();
    return;
  }

  const matches = (promptText.match(/\[DELIVER from/g) ?? []).length;
  const state = loadState();
  state.delivered += matches;
  saveState(state);

  if (state.delivered >= 2) {
    await callTool(client, 'toolu_captain_deliver', 'deliver', { text: 'FINAL: combined scan A + scan B' });
    const text = 'delivered final result';
    assistantText(text);
    resultEvent(text);
  } else {
    const text = 'still waiting on crew';
    assistantText(text);
    resultEvent(text);
  }
  await client.close();
}

main().catch(err => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
