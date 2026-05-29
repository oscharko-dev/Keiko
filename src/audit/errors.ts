// Audit error taxonomy, mirroring gateway/harness/workspace/tools (ADR-0003..0006). Errors carry a
// stable `code` discriminant; callers switch on `code`, never parse `message`. Every message is
// redacted at construction (D11: typed errors with redacted messages) so errors are always safe to
// log or surface.

import { redact } from "../gateway/redaction.js";

export const AUDIT_CODES = {
  INVALID_RUN_ID: "AUDIT_INVALID_RUN_ID",
  WRITE: "AUDIT_WRITE",
  SCHEMA: "AUDIT_SCHEMA",
  READ: "AUDIT_READ",
} as const;

export type AuditCode = (typeof AUDIT_CODES)[keyof typeof AUDIT_CODES];

export abstract class AuditError extends Error {
  abstract readonly code: AuditCode;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

// A runId failed the bounded character-class / length validation (D4 iii). Nothing was written.
export class InvalidRunIdError extends AuditError {
  readonly code = AUDIT_CODES.INVALID_RUN_ID;
}

// A write or delete at the filesystem boundary failed, or a path escaped the contained base dir.
export class EvidenceWriteError extends AuditError {
  readonly code = AUDIT_CODES.WRITE;
}

// A persisted manifest could not be parsed as JSON (truncated, hand-edited, or corrupt). Surfaced as
// a typed error so the CLI maps it to a clean exit code instead of leaking a raw SyntaxError (C1).
export class EvidenceReadError extends AuditError {
  readonly code = AUDIT_CODES.READ;
}

// A persisted manifest carried an unrecognised evidenceSchemaVersion (D5) — not silently coerced.
export class EvidenceSchemaError extends AuditError {
  readonly code = AUDIT_CODES.SCHEMA;
  readonly foundVersion: string;

  constructor(message: string, foundVersion: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.foundVersion = foundVersion;
  }
}
