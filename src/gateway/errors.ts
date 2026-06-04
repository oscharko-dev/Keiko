// Re-export shim: the gateway error taxonomy now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "../gateway/errors.js"`) keep
// resolving unchanged via this barrel.

export {
  ERROR_CODES,
  GatewayError,
  AuthenticationError,
  TransportError,
  ModelRefusalError,
  MalformedToolCallError,
  ContextOverflowError,
  RateLimitError,
  TimeoutError,
  CancelledError,
  CircuitOpenError,
  ProviderError,
  ConfigInvalidError,
  UnknownModelError,
} from "@oscharko-dev/keiko-security/errors/gateway";
export type { ErrorCode } from "@oscharko-dev/keiko-security/errors/gateway";
