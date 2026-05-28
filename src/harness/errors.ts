// Harness error taxonomy, mirroring the gateway pattern (ADR-0003). Errors carry a
// stable `code` discriminant; callers switch on `code`, never parse `message`.
// Messages are redacted at construction so they are always safe to log.

import { redact } from "../gateway/redaction.js";
import { HARNESS_CODES, type HarnessCode, type HarnessFailure } from "./types.js";

export { HARNESS_CODES };
export type { HarnessCode };

export abstract class HarnessError extends Error {
  abstract readonly code: HarnessCode;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

// Raised when a configured safety limit is breached. Carries the precise category so
// the loop can map it onto a `limit-exceeded` terminal state with a typed failure.
export class LimitExceededError extends HarnessError {
  readonly code: HarnessCode;

  constructor(code: HarnessCode, message: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.code = code;
  }
}

// Raised for a non-recoverable model-port error after retries are exhausted.
export class HarnessModelError extends HarnessError {
  readonly code = HARNESS_CODES.MODEL_ERROR;
}

// Raised for a non-recoverable tool-port error.
export class HarnessToolError extends HarnessError {
  readonly code = HARNESS_CODES.TOOL_ERROR;
}

// Raised for an unexpected harness-internal invariant violation (e.g. an explain-plan
// task receiving a tool_calls finishReason, which the read-only path forbids).
export class HarnessInternalError extends HarnessError {
  readonly code = HARNESS_CODES.INTERNAL;
}

// Builds the machine-readable failure record carried on the run result and the
// `run:failed` event. `detail` is SENSITIVE and must be redacted before persistence.
export function toFailure(category: HarnessCode, message: string, detail?: string): HarnessFailure {
  return detail === undefined ? { category, message } : { category, message, detail };
}
