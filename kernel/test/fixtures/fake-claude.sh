#!/usr/bin/env bash
# Stub for `claude` used by ClaudeCodeDriver tests. Never invokes the real CLI.
# Appends its argv (as one JSON array line) to $FAKE_CLI_LOG, then prints the
# canned reply from the file named by $FAKE_CLI_REPLY verbatim to stdout.
# Since the driver now runs `--output-format stream-json`, the reply file
# holds raw NDJSON (one JSON object per line — assistant/result/etc. events)
# for tests to script multi-turn, multi-event conversations. Tests rewrite
# that file between calls (env is read once at spawn time, so the reply must
# live behind a file, not the env var itself).
set -euo pipefail
node -e 'require("fs").appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@"
cat "$FAKE_CLI_REPLY"
