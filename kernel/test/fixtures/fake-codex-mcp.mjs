#!/usr/bin/env node
// Stub for `codex` used by McpCodexDriver's MCP round-trip test. Unlike
// fake-codex.sh (which just echoes a canned reply and never touches the
// network), this stub actually acts as an MCP CLIENT: it parses the
// `-c mcp_servers.flota.url="..."` flag and the FLOTA_MCP_TOKEN env var out of
// its own invocation (exactly what a real MCP-aware codex would be configured
// with), connects to the real FlotaMcpServer the test stood up, calls the
// `delegate` tool for real, and only then prints codex-style --json JSONL
// (item.started / item.completed mcp_tool_call + a final agent_message) —
// proving the whole loop (argv -> MCP config -> real tool call -> JSONL
// codex would emit) round-trips, not just that argv parses.
//
// If FAKE_CLI_LOG is set, the received argv is also appended there (one JSON
// array per line, like fake-codex.sh) so a single invocation can be checked
// both for exact argv shape (approve mode, bearer_token_env_var, url) AND for
// the real tool call firing.
import { appendFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(argv) + '\n');
}

const isResume = argv[0] === 'exec' && argv[1] === 'resume';

function flagValue(prefix) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-c' && typeof argv[i + 1] === 'string' && argv[i + 1].startsWith(prefix)) {
      return argv[i + 1].slice(prefix.length).replace(/^"|"$/g, '');
    }
  }
  return undefined;
}

const url = flagValue('mcp_servers.flota.url=');
const bearerEnvVar = flagValue('mcp_servers.flota.bearer_token_env_var=') ?? 'FLOTA_MCP_TOKEN';

if (!url) {
  console.error('fake-codex-mcp: no mcp_servers.flota.url found in argv');
  process.exit(1);
}

const token = process.env[bearerEnvVar];
const lines = [];
if (!isResume) {
  lines.push(JSON.stringify({ type: 'session_started', session_id: 'sess-stub-mcp-1' }));
}

const client = new Client({ name: 'fake-codex-mcp', version: '0.0.1' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
await client.connect(transport);

const toolArgs = { role: 'x', charter: 'y', task: 'z' };
lines.push(JSON.stringify({
  type: 'item.started',
  item: { id: 'item_1', type: 'mcp_tool_call', server: 'flota', tool: 'delegate', arguments: toolArgs, result: null, error: null, status: 'in_progress' },
}));

const result = await client.callTool({ name: 'delegate', arguments: toolArgs });
const resultText = result.content?.[0]?.text ?? '';

lines.push(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_1', type: 'mcp_tool_call', server: 'flota', tool: 'delegate', arguments: toolArgs,
    result: { content: [{ type: 'text', text: resultText }], structured_content: null }, error: null, status: 'completed',
  },
}));

await client.close();

lines.push(JSON.stringify({ type: 'agent_message', text: `Delegated: ${resultText}` }));

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
