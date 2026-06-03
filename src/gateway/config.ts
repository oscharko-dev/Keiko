// Re-export shim: config now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/config.js"`) keep resolving unchanged via this barrel.

export {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  toSafeObject,
  validateBaseUrl,
} from "@oscharko-dev/keiko-model-gateway";
export type {
  EnvSource,
  SafeGatewayConfig,
  SafeProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
