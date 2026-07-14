import { CliDriver, type CliDriverOptions } from './cliDriver.js';
import { CODEX_SPEC } from './specs.js';

// Kept for the public API / callers that named this options type.
export type CodexDriverOptions = CliDriverOptions;

// WHY a thin preset over CliDriver: codex is now one CliDriverSpec (CODEX_SPEC)
// — command + arg builders + stdout parser. All turn-loop behavior lives in
// CliDriver; this class only binds the spec.
export class CodexDriver extends CliDriver {
  constructor(opts: CodexDriverOptions) {
    super(CODEX_SPEC, opts);
  }
}
