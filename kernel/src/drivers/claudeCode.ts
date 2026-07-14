import { CliDriver, type CliDriverOptions } from './cliDriver.js';
import { CLAUDE_CODE_SPEC } from './specs.js';

// Kept for the public API / callers that named this options type.
export type ClaudeCodeDriverOptions = CliDriverOptions;

// WHY a thin preset over CliDriver: claude-code is now one CliDriverSpec
// (CLAUDE_CODE_SPEC) — command + arg builders + stdout parser. All turn-loop
// behavior lives in CliDriver; this class only binds the spec.
export class ClaudeCodeDriver extends CliDriver {
  constructor(opts: ClaudeCodeDriverOptions) {
    super(CLAUDE_CODE_SPEC, opts);
  }
}
