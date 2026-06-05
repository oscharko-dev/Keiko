// Typed error surface for the retrieval layer. Each call-site that throws picks one
// discriminated code so callers (Conversation Center, workflow agents, audit) can branch
// on `err.code` without parsing strings. The code set is intentionally small — all
// recoverable input shapes are validated up-front (`empty-scopes`, `invalid-budget`,
// `invalid-weight`) and any port-side failure is wrapped under one umbrella
// (`port-failure`) carrying the underlying error in `cause`.

export type RetrievalErrorCode =
  | "empty-scopes"
  | "invalid-budget"
  | "invalid-weight"
  | "port-failure";

export class RetrievalError extends Error {
  public override readonly name = "RetrievalError";
  public readonly code: RetrievalErrorCode;

  public constructor(code: RetrievalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
