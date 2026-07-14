#!/usr/bin/env bash
# Stub for `codex` used by CodexDriver tests. Never invokes the real CLI.
# Appends its argv (as one JSON array line) to $FAKE_CLI_LOG, then prints the
# canned reply from the file named by $FAKE_CLI_REPLY — tests rewrite that
# file between calls to script multi-turn conversations (env is read once at
# spawn time, so the reply must live behind a file, not the env var itself).
# Unlike fake-claude.sh's single JSON object, the reply file here holds raw
# JSONL text (one event per line) — codex exec --json's actual stdout shape.
set -euo pipefail
node -e 'require("fs").appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@"
cat "$FAKE_CLI_REPLY"
