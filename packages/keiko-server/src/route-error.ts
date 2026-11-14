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
  return {
    error: {
      code,
      message,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(refusal === undefined ? {} : { reason: refusal.reason }),
      ...(refusal?.line === undefined ? {} : { line: refusal.line }),
    },
  };
}
