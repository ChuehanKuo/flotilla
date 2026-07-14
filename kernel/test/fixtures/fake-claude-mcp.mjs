#!/usr/bin/env node
// Stub for `claude` used by McpClaudeDriver tests. Never invokes the real CLI.
// Unlike fake-claude.sh (which just echoes a canned reply), this stub ACTUALLY
// round-trips through a real (test-hosted) FlotaMcpServer: it reads its own
// --mcp-config argv, extracts the flota server's url + bearer token, opens a
// real MCP client connection, and calls the delegate tool for real — proving
// the driver wired the server+token into the argv correctly end-to-end.
//
// Appends its argv (as one JSON array line) to $FAKE_CLI_LOG, same convention
// as fake-claude.sh/fake-codex.sh, so tests can assert on the exact args a
// resume turn re-passes (--resume, --mcp-config, --allowedTools).
//
// Emits real stream-json lines matching the verbatim shapes from
// .superpowers/sdd/mcp-spike-findings.md §3: a tool_use event, a tool_result
// event carrying the server's actual response text, a final assistant text
// event, and a result event with session_id + usage.
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

const mcpConfigRaw = flagValue('--mcp-config');
if (!mcpConfigRaw) {
  // No --mcp-config to round-trip through (e.g. an argv-shape-only probe) —
  // nothing more to do.
  process.exit(0);
}

const mcpConfig = JSON.parse(mcpConfigRaw);
const flota = mcpConfig.mcpServers.flota;
const authHeader = flota.headers?.Authorization ?? '';
const token = authHeader.replace(/^Bearer\s+/i, '');

// WHY fixed args, not env-configurable: keeps the stub simple; tests assert
// against these exact literal values in the spy KernelApi call.
const DELEGATE_ARGS = { role: 'metrics-scan', charter: 'scan the repo', task: 'find dead code' };
const TOOL_USE_ID = 'toolu_fake_001';
const SESSION_ID = 'sess-mcp-1';

async function main() {
  const client = new Client({ name: 'fake-claude-mcp', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(flota.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  // tool_use event (assistant message) — shape verified in the spike findings.
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'mcp__flota__delegate', input: DELEGATE_ARGS }] },
    session_id: SESSION_ID,
  }));

  // The REAL round trip: this actually calls FlotaMcpServer's delegate tool,
  // which calls the spy KernelApi's delegate() and returns its string.
  const result = await client.callTool({ name: 'delegate', arguments: DELEGATE_ARGS });
  const resultText = result.content?.[0]?.text ?? '';

  // tool_result event (user message wrapping the result) — shape verified in
  // the spike findings, both content[] and top-level tool_use_result[] carry it.
  console.log(JSON.stringify({
    type: 'user',
    message: { content: [{ tool_use_id: TOOL_USE_ID, type: 'tool_result', content: [{ type: 'text', text: resultText }] }] },
    tool_use_result: [{ type: 'text', text: resultText }],
  }));

  const finalText = `Delegated: ${resultText}`;

  // Final assistant narration.
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: finalText }] },
    session_id: SESSION_ID,
  }));

  // result event — the final-turn summary the driver prefers as displayText.
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: finalText,
    session_id: SESSION_ID,
    usage: { input_tokens: 42, output_tokens: 7 },
  }));

  await client.close();
}

main().catch(err => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
