// Shared redacting error base [GEN-DUP-INTENTIONAL-001, GEN-MAINT-COUPLING-003/004]. Seven per-layer
// abstract error bases (gateway/audit/workspace/tools/harness/verification/promptEnhancer) each carried
// a byte-identical constructor: `super(redact(message, secrets)); this.name = new.target.name;`. That
// duplication is hoisted here so the redact-at-construction invariant lives in exactly one place — a
// message can never reach a log line, evidence artifact, or trust boundary un-redacted, for any layer.
//
// Every per-layer base now extends RedactingError, keeping ONLY its own `abstract readonly code` (and,
// for the gateway, its `abstract readonly retryable`). The per-layer module split is intentional and
// preserved: callers still subpath-import `@oscharko-dev/keiko-security/errors/<layer>`.
//
// SecretboxError is deliberately EXEMPT from this base: it is a generic, non-redacting primitive whose
// message is already secret-free by construction (never echoes key/plaintext/ciphertext), so wrapping
// it in redact() would add nothing. See errors/base.test.ts for the documented exemption.

import { redact } from "../redaction.js";

export abstract class RedactingError extends Error {
  abstract readonly code: string;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    // new.target is the concrete subclass being constructed, so `.name` is always the precise
    // subclass name (e.g. "AuthenticationError") without each subclass re-assigning it.
    this.name = new.target.name;
  }
}
