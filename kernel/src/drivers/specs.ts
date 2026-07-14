// WHY a spec, not a class hierarchy: every CLI driver's turn() body is identical
// except for (a) how the argv is built (first turn vs resume) and (b) how the
// subprocess stdout is parsed into transcript/displayText/sessionId/usage. A
// CliDriverSpec factors exactly those two axes out so CliDriver can own the one
// shared turn loop, and claude-code/codex become data (presets) rather than code.

// Context handed to a spec's arg builders. `protocol` is PROTOCOL_INSTRUCTIONS,
// passed in so a spec that needs it (claude appends it to the first-turn system
// prompt; codex embeds it in the first-turn charter) doesn't re-import it.
export interface CliTurnCtx {
  prompt: string;
  system: string;
  workspaceDir: string;
  protocol: string;
  sessionId?: string;
}

// The reduction of a subprocess's stdout to what the shared turn loop needs.
// `transcript` is scanned for the flotilla command block; `displayText` (when
// present) is the clean text shown to the user, distinct from the full
// multi-turn transcript. `parse` throws on unusable output so the node's
// retry-then-escalate machinery handles it — never a silently-empty turn.
export interface CliParseResult {
  transcript: string;
  displayText?: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
}

// Passed to parse alongside stdout. WHY isFirstTurn is needed: codex's
// missing-session-id guard fires only on the turn that must ESTABLISH a session
// — but a first-turn stream and a resume-turn stream can be byte-identical
// (both just `[{type:'agent_message',text:...}]`), so parse cannot recover
// first-turn-ness from stdout. CliDriver already computes it (to pick
// firstArgs vs resumeArgs) and hands it down here. Specs that don't care
// (claude) ignore it; the arg is optional so a parse can still be called with
// only stdout.
// WHY worth flagging here: omitting ctx disables first-turn-only guards (e.g.
// CODEX_SPEC's missing-session-id check) — CliDriver always supplies it, but an
// external caller invoking a preset's parse(stdout) directly does not get one.
export interface CliParseCtx { isFirstTurn: boolean }

export interface CliDriverSpec {
  command: string;
  firstArgs(ctx: CliTurnCtx): string[];
  resumeArgs(ctx: CliTurnCtx): string[]; // ctx.sessionId is defined here
  parse(stdout: string, ctx?: CliParseCtx): CliParseResult; // throws on unusable output
  timeoutMs?: number;
}

// ── claude-code ────────────────────────────────────────────────────────────

// WHY only `type`/`message.content[].type|text`/`session_id`/`result`/`usage`
// fields: `claude -p --output-format stream-json --verbose` emits one JSON
// object per line — shape verified against the installed CLI (2.1.207) via a
// non-mutating probe (`-p "..." --output-format stream-json --verbose
// --allowedTools ''`). Real streams also carry `system` (init/hook) and
// `rate_limit_event` lines and `thinking`/`tool_use` content blocks — all
// silently ignored by the narrow shape below rather than enumerated.
interface StreamEvent {
  type?: unknown;
  message?: { content?: unknown };
  session_id?: unknown;
  result?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

// WHY line-by-line with per-line try/catch: stream-json prints NDJSON, one
// event object per line — a single JSON.parse(stdout) would fail on the
// very first reply. Unparseable individual lines are skipped rather than
// failing the whole turn (log noise, partial writes) — mirrors CODEX_SPEC's
// parse.
function parseClaudeStdout(stdout: string): CliParseResult {
  const turnTexts: string[] = [];
  let resultEvent: StreamEvent | undefined;
  let lastAssistantSessionId: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip unparseable lines
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const event = parsed as StreamEvent;

    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
            const blockText = (block as { text?: unknown }).text;
            if (typeof blockText === 'string') parts.push(blockText);
          }
        }
        if (parts.length > 0) turnTexts.push(parts.join(''));
      }
      if (typeof event.session_id === 'string') lastAssistantSessionId = event.session_id;
    } else if (event.type === 'result') {
      resultEvent = event;
    }
  }

  // WHY join with '\n': FENCE_RE (protocol.ts) requires a flotilla block's
  // opening fence to start at a line boundary. Assistant turn texts aren't
  // guaranteed to end with a trailing newline, so concatenating turns with
  // '' could glue one turn's tail directly onto the next turn's leading
  // ```flotilla and hide a genuine block from the regex.
  const fullTranscript = turnTexts.join('\n');
  const resultText = resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result : undefined;

  // Zero parseable lines from non-empty garbage stdout, or valid NDJSON that
  // never carried a result event or any assistant text (e.g. only system/
  // rate_limit_event lines) — both leave nothing for the node to act on.
  if (fullTranscript === '' && resultText === undefined) {
    throw new Error('claude produced no result event and no assistant text');
  }

  const sessionId =
    (resultEvent && typeof resultEvent.session_id === 'string' ? resultEvent.session_id : undefined) ??
    lastAssistantSessionId;
  const usage = resultEvent?.usage ?? {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  // WHY displayText comes from resultText but transcript stays the full stream:
  // headless Claude runs its own internal multi-turn loop and can emit its
  // flotilla block in an intermediate turn, then narrate in its final turn (the
  // `result` event's text) without repeating the block — CliDriver scans
  // `transcript` for the block (catches it wherever it appeared) but shows
  // `displayText` (the clean final-turn summary) to the user. When there's no
  // result event, displayText is undefined and CliDriver falls back to the
  // transcript's clean text.
  return {
    transcript: fullTranscript,
    displayText: resultText,
    sessionId,
    usage: { inputTokens, outputTokens },
  };
}

export const CLAUDE_CODE_SPEC: CliDriverSpec = {
  command: 'claude',
  firstArgs(ctx) {
    return buildClaudeArgs(ctx.prompt, ['--append-system-prompt', `${ctx.system}\n\n${ctx.protocol}`]);
  },
  resumeArgs(ctx) {
    return buildClaudeArgs(ctx.prompt, ['--resume', ctx.sessionId as string]);
  },
  parse: parseClaudeStdout,
};

function buildClaudeArgs(promptText: string, auth: string[]): string[] {
  // WHY Tool(**) not bare Tool names: unscoped Read/Write/Edit let the CLI
  // touch any path reachable from its own permission model, not just this
  // node's mission workspace. Permission rules take a `Tool(specifier)`
  // glob scoped to cwd (verified via `claude --help`'s own allowedTools
  // example and the CLI's rule-format validation message, which both cite
  // gitignore-style relative globs, e.g. "Edit(docs/**)"); since cwd is
  // already workspaceDir (see CliDriver's execFile `cwd`), `**` scopes every
  // Read/Write/Edit to inside it. Glob/Grep stay unscoped (read-only search).
  return [
    '-p', promptText,
    '--output-format', 'stream-json',
    '--verbose',
    ...auth,
    '--allowedTools', 'Read(**),Write(**),Edit(**),Glob,Grep',
  ];
}

// ── codex ──────────────────────────────────────────────────────────────────

interface CodexEvent {
  type?: unknown;
  text?: unknown;
  session_id?: unknown;
  thread_id?: unknown;
}

// WHY line-by-line with per-line try/catch: codex exec --json prints JSONL, one
// event object per line — a single JSON.parse(stdout) (the claude approach)
// would fail on the very first reply. Unparseable individual lines are skipped
// rather than failing the whole turn (log noise, partial writes).
//
function parseCodexStdout(stdout: string, ctx?: CliParseCtx): CliParseResult {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') events.push(parsed as CodexEvent);
    } catch {
      // skip unparseable lines
    }
  }

  if (events.length === 0 && stdout.trim() === '') {
    throw new Error('codex exec produced no parseable output');
  }

  let sessionId: string | undefined;
  for (const e of events) {
    const id = typeof e.session_id === 'string' ? e.session_id : typeof e.thread_id === 'string' ? e.thread_id : undefined;
    if (id) { sessionId = id; break; }
  }

  // WHY events.length > 0 gates this: zero parseable events falls straight to
  // the raw-stdout fallback below (a distinct, pre-existing degenerate case —
  // e.g. a CLI printing plain text, not JSONL at all). This guard targets a
  // stream that DID parse as valid JSONL but never carried a session/thread id
  // on the turn establishing a fresh session — the likeliest real-CLI
  // shape-mismatch symptom. Silent fresh-session-per-turn amnesia is worse
  // than a loud failure the retry-then-escalate machinery can react to.
  if (events.length > 0 && ctx?.isFirstTurn && !sessionId) {
    throw new Error('codex output carried no session/thread id');
  }

  const agentMessageParts = events
    .filter(e => typeof e.type === 'string' && e.type.includes('agent_message') && typeof e.text === 'string')
    .map(e => e.text as string);

  let text: string;
  if (agentMessageParts.length > 0) {
    text = agentMessageParts.join('');
  } else {
    const last = events[events.length - 1];
    text = last && typeof last.text === 'string' ? last.text : stdout.trim();
  }

  // WHY throw instead of returning '' (and why trim(), not ===''): an empty
  // or whitespace-only "success" would silently drain the pending-command-
  // results queue and complete a node turn with nothing — fail loudly so
  // retry-then-escalate surfaces it instead.
  if (text.trim() === '') throw new Error('empty turn text from codex output');

  // WHY always zero usage: codex exec --json's event stream carries no
  // brief-specified token-usage event; unlike claude's reply.usage, there is
  // nothing here to defensively default away from — no speculative parsing of
  // an unspecified event shape.
  return { transcript: text, sessionId, usage: { inputTokens: 0, outputTokens: 0 } };
}

export const CODEX_SPEC: CliDriverSpec = {
  command: 'codex',
  firstArgs(ctx) {
    // WHY charter woven into the first-turn PROMPT (not a flag): codex exec has
    // no system-prompt flag, so system + protocol travel inside the prompt
    // itself under a `[role charter]` header. resumeArgs omits it: re-sending it
    // on every resumed turn would waste tokens and drift from claude's "system
    // only once" behavior — the resumed session already has it from turn one.
    const promptText = `[role charter]\n${ctx.system}\n\n${ctx.protocol}\n\n${ctx.prompt}`;
    return ['exec', promptText, '--json', '--cd', ctx.workspaceDir, '--sandbox', 'workspace-write'];
  },
  // WHY no --cd/--sandbox here: the brief's args assumed `exec resume` accepts the
  // same flags as `exec`. Verified against the installed CLI (codex-cli 0.144.3)
  // via `codex exec resume --cd /tmp --sandbox workspace-write --help`, which
  // errors "unexpected argument '--cd' found" (and likewise for --sandbox alone) —
  // the resume subcommand only takes [SESSION_ID] [PROMPT] plus its own flag set
  // (--json among them). The resumed session already carries the cwd/sandbox
  // policy set on the first turn.
  resumeArgs(ctx) {
    return ['exec', 'resume', ctx.sessionId as string, ctx.prompt, '--json'];
  },
  parse: parseCodexStdout,
};
