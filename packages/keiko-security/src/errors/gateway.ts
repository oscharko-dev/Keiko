// Typed gateway error taxonomy with stable string `code` discriminants. Callers switch on
// `error.code`; they never parse `error.message`. Every message is redacted at construction
// so errors are always safe to log or surface across trust boundaries (ADR-0003).

import { redact } from "../redaction.js";

export const ERROR_CODES = {
  AUTHENTICATION: "GATEWAY_AUTHENTICATION",
  TRANSPORT: "GATEWAY_TRANSPORT",
  MODEL_REFUSAL: "GATEWAY_MODEL_REFUSAL",
  MALFORMED_TOOL_CALL: "GATEWAY_MALFORMED_TOOL_CALL",
  CONTEXT_OVERFLOW: "GATEWAY_CONTEXT_OVERFLOW",
  RATE_LIMIT: "GATEWAY_RATE_LIMIT",
  TIMEOUT: "GATEWAY_TIMEOUT",
  CANCELLED: "GATEWAY_CANCELLED",
  CIRCUIT_OPEN: "GATEWAY_CIRCUIT_OPEN",
  PROVIDER_ERROR: "GATEWAY_PROVIDER_ERROR",
  CONFIG_INVALID: "GATEWAY_CONFIG_INVALID",
  UNKNOWN_MODEL: "GATEWAY_UNKNOWN_MODEL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export abstract class GatewayError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

export class AuthenticationError extends GatewayError {
  readonly code = ERROR_CODES.AUTHENTICATION;
  readonly retryable = false;
}

export class TransportError extends GatewayError {
  readonly code = ERROR_CODES.TRANSPORT;
  readonly retryable = true;
}

export class ModelRefusalError extends GatewayError {
  readonly code = ERROR_CODES.MODEL_REFUSAL;
  readonly retryable = false;
}

export class MalformedToolCallError extends GatewayError {
  readonly code = ERROR_CODES.MALFORMED_TOOL_CALL;
  readonly retryable = false;
}

export class ContextOverflowError extends GatewayError {
  readonly code = ERROR_CODES.CONTEXT_OVERFLOW;
  readonly retryable = false;
}

export class RateLimitError extends GatewayError {
  readonly code = ERROR_CODES.RATE_LIMIT;
  readonly retryable = true;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    retryAfterMs: number | null = null,
    secrets: readonly string[] = [],
  ) {
    super(message, secrets);
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends GatewayError {
  readonly code = ERROR_CODES.TIMEOUT;
  readonly retryable = true;
}

export class CancelledError extends GatewayError {
  readonly code = ERROR_CODES.CANCELLED;
  readonly retryable = false;
}

export class CircuitOpenError extends GatewayError {
  readonly code = ERROR_CODES.CIRCUIT_OPEN;
  readonly retryable = false;
}

export class ProviderError extends GatewayError {
  readonly code = ERROR_CODES.PROVIDER_ERROR;
  readonly retryable = false;
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number, secrets: readonly string[] = []) {
    super(message, secrets);
    this.httpStatus = httpStatus;
  }
}

export class ConfigInvalidError extends GatewayError {
  readonly code = ERROR_CODES.CONFIG_INVALID;
  readonly retryable = false;
}

export class UnknownModelError extends GatewayError {
  readonly code = ERROR_CODES.UNKNOWN_MODEL;
  readonly retryable = false;
}
