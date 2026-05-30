// Verification error taxonomy, mirroring the workspace/tools pattern (ADR-0005/0006). Errors
// carry a stable `code` discriminant; callers switch on `code`, never parse `message`. Every
// message is redacted at construction so errors are always safe to log. The only verification
// error surfaced today is at the CLI/IO boundary (workspace detection failures are surfaced by
// the workspace layer's own WorkspaceError); this base exists so later boundary failures have a
// typed home without re-deriving the pattern.

import { redact } from "../gateway/redaction.js";

export const VERIFICATION_CODES = {
  PLAN_EMPTY: "VERIFICATION_PLAN_EMPTY",
} as const;

export type VerificationCode = (typeof VERIFICATION_CODES)[keyof typeof VERIFICATION_CODES];

export abstract class VerificationError extends Error {
  abstract readonly code: VerificationCode;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

// Raised when a verification run is requested but the plan contains no steps (e.g. --only with an
// empty selection). Surfaced as a non-green verification error at the CLI boundary.
export class EmptyPlanError extends VerificationError {
  readonly code = VERIFICATION_CODES.PLAN_EMPTY;
}
