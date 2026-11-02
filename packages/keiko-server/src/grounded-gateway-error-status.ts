import type { GatewayError } from "@oscharko-dev/keiko-model-gateway";

/**
 * The HTTP status of a gateway failure on the grounded answer routes (Knowledge Pod, connected
 * context, plural and hybrid answers). One implementation for every grounded route, so a caller's
 * exhausted attempt or token grant is the nonretryable 403 `GATEWAY_ATTEMPT_ADMISSION_DENIED` the
 * client shows as a request-limit notice on every path, never a 502 provider failure.
 */
export function gatewayErrorStatus(error: GatewayError): number {
  if (error.code === "GATEWAY_AUTHENTICATION") return 401;
  if (error.code === "GATEWAY_ATTEMPT_ADMISSION_DENIED") return 403;
  if (error.retryable) return 503;
  return 502;
}
