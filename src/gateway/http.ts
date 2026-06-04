// Re-export shim: http now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/http.js"`) keep resolving unchanged via this barrel.

export {
  gatewayFetch,
  gatewayTrustedCaCertificates,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  readJsonCapped,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
export type { GatewayFetchOptions } from "@oscharko-dev/keiko-model-gateway/internal/http";
