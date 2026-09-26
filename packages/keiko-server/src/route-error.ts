export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId?: string;
  };
}

export function errorBody(code: string, message: string, correlationId?: string): ApiError {
  return { error: { code, message, ...(correlationId === undefined ? {} : { correlationId }) } };
}
