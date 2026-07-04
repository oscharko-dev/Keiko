// Typed error surface for the retrieval layer. Each call-site that throws picks one
// discriminated code so callers (Conversation Center, workflow agents, audit) can branch
// on `err.code` without parsing strings. The code set is intentionally small — all
// recoverable input shapes are validated up-front (`empty-scopes`, `invalid-budget`,
// `invalid-weight`) and any port-side failure is wrapped under one umbrella
// (`port-failure`) carrying the underlying error in `cause`.
//
// Redaction is enforced by construction via the shared RedactingError base: the message is
// scrubbed of secret shapes before it can reach `.message` [GEN-MAINT-COUPLING-003/004]. The
// wrapped `cause` is preserved verbatim for programmatic inspection; only the human-readable
// `.message` crosses the redaction boundary. The per-domain code union stays LOCAL to this package.

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";

export type RetrievalErrorCode =
  "empty-scopes" | "invalid-budget" | "invalid-threshold" | "invalid-weight" | "port-failure";

export class RetrievalError extends RedactingError {
  public readonly code: RetrievalErrorCode;

  public constructor(code: RetrievalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
