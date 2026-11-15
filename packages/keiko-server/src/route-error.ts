import { isMarkdownSkillRefusalReason } from "@oscharko-dev/keiko-contracts/bff-wire";

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId?: string;
    /** A closed refusal reason a route may add so the browser can say what to change. */
    readonly reason?: string;
    readonly line?: number;
  };
}

export function errorBody(
  code: string,
  message: string,
  correlationId?: string,
  refusal?: { readonly reason: string; readonly line?: number },
): ApiError {
  // The wire carries only a reason from the closed vocabulary; any other value is dropped.
  const known = refusal !== undefined && isMarkdownSkillRefusalReason(refusal.reason);
  return {
    error: {
      code,
      message,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(known ? { reason: refusal.reason } : {}),
      ...(known && refusal.line !== undefined ? { line: refusal.line } : {}),
    },
  };
}
