// Typed gateway error taxonomy with stable string `code` discriminants. Callers switch on
// `error.code`; they never parse `error.message`. Every message is redacted at construction
// so errors are always safe to log or surface across trust boundaries (ADR-0003).

import { RedactingError } from "./base.js";

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
  PROXY_UNREACHABLE: "GATEWAY_PROXY_UNREACHABLE",
  PROXY_AUTH_REQUIRED: "GATEWAY_PROXY_AUTH_REQUIRED",
  PROXY_EGRESS_FAILED: "GATEWAY_PROXY_EGRESS_FAILED",
  PROXY_BLOCKED_BY_POLICY: "GATEWAY_PROXY_BLOCKED_BY_POLICY",
  TLS_CA_FAILURE: "GATEWAY_TLS_CA_FAILURE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type GatewayEgressErrorCode =
  | typeof ERROR_CODES.PROXY_UNREACHABLE
  | typeof ERROR_CODES.PROXY_AUTH_REQUIRED
  | typeof ERROR_CODES.PROXY_EGRESS_FAILED
  | typeof ERROR_CODES.PROXY_BLOCKED_BY_POLICY
  | typeof ERROR_CODES.TLS_CA_FAILURE;

// Token usage a streaming call had already accumulated when it failed mid-stream.
// Counts only — never content — so it can ride on redacted operator diagnostics
// and keep cost accounting from silently losing the interrupted turn.
export interface PartialStreamUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly streamedChars: number;
}

export abstract class GatewayError extends RedactingError {
  abstract override readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  // RB-6 (GEN-OBS-CORRELATION-503): the gateway's own per-call request id, attached at the throw site
  // so a FAILED model call — not just a successful one (usage.requestId) — can be tied back to the
  // gateway's record and to the server/UI correlation id. Optional so no constructor changes and no
  // existing GatewayError construction/test is affected.
  requestId?: string;
  // Usage accumulated before a MID-STREAM failure (same attach-at-throw-site pattern
  // as requestId above): optional so no constructor changes and no existing
  // GatewayError construction/test is affected. Counts only, never content.
  partialUsage?: PartialStreamUsage;
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

// Provider 5xx responses are transient by the providers' own contracts (both
// OpenAI-compatible and Anthropic APIs document retry-with-backoff for
// 500/502/503/529); everything else a ProviderError carries (4xx validation,
// permission, not-found …) is terminal. Streaming calls never enter the retry
// loop (Gateway.chatStream is deliberately not wrapped in executeWithRetry), so
// this flag re-enables retries for idempotent, buffered calls only.
const RETRYABLE_PROVIDER_HTTP_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 529]);

export class ProviderError extends GatewayError {
  readonly code = ERROR_CODES.PROVIDER_ERROR;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number, secrets: readonly string[] = []) {
    super(message, secrets);
    this.httpStatus = httpStatus;
    this.retryable = RETRYABLE_PROVIDER_HTTP_STATUS.has(httpStatus);
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

export class GatewayEgressError extends GatewayError {
  readonly code: GatewayEgressErrorCode;
  readonly retryable = false;

  constructor(code: GatewayEgressErrorCode, message: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.code = code;
  }
}
