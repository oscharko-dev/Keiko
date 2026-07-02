// Public barrel for @oscharko-dev/keiko-security. Re-exports every shared primitive so callers
// can `import { redact, GatewayError, assertValidRunId, sha256Hex } from "@oscharko-dev/keiko-security"`
// without knowing which sub-module owns the symbol. Subpath imports (`./errors/gateway`, etc.) are
// available for callers who want to pull in a narrower surface — both flat and subpath imports
// resolve to the same module instance.

export { KEIKO_SECURITY_VERSION } from "./version.js";

export {
  redact,
  createAuditRedactor,
  deepRedactStrings,
  isCredentialKeyName,
  objectContainsCredentialKey,
} from "./redaction.js";

export { assertValidRunId } from "./runid.js";

export type { EnvSource } from "./secrets.js";
export { isKeikoApiKeyEnvName, keikoApiKeySecretValues } from "./secrets.js";

export { canonicalise, sha256Hex, sha256Base64 } from "./hashing.js";

export { sealString, openString, sealBytes, openBytes, isSealed } from "./secretbox.js";

// Prompt Enhancer authoritative injection / unsafe-content detector (#1313, ADR-0044 §1/§5).
export type {
  PromptInjectionSignalCode,
  PromptInjectionSeverity,
  PromptInjectionSignal,
} from "./promptInjection.js";
export {
  PROMPT_INJECTION_SIGNAL_CODES,
  isPromptInjectionSignalCode,
  detectPromptInjectionSignals,
  containsRedactableSecret,
  hasCriticalInjectionSignal,
} from "./promptInjection.js";

export * from "./errors/index.js";
