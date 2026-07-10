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
  redactWithRuleCounts,
  SHARED_REDACTION_RULE_CODES,
} from "./redaction.js";
export type {
  SharedRedactionResult,
  SharedRedactionRuleCode,
  SharedRedactionRuleCount,
} from "./redaction.js";

export type { SensitiveTextSignal } from "./sensitive-text.js";
export { looksLikeEuDePii, scanSensitiveText, SENSITIVE_TEXT_SIGNALS } from "./sensitive-text.js";

export type {
  FeedbackCanonicalBodyErrorCodeV1,
  FeedbackCanonicalBodyV1,
  FeedbackReportRedactionPolicyParseV1,
  FeedbackReportRedactionPolicyV1,
  PreparedFeedbackReportV1,
  PrepareFeedbackReportResultV1,
  VerifyCanonicalFeedbackReportBodyInputV1,
  VerifyCanonicalFeedbackReportBodyResultV1,
} from "./feedback-report.js";
export {
  FEEDBACK_CANONICAL_BODY_ERROR_CODES_V1,
  FEEDBACK_REPORT_REDACTION_POLICY_LIMITS_V1,
  parseFeedbackReportRedactionPolicyV1,
  prepareFeedbackReportV1,
  verifyCanonicalFeedbackReportBodyV1,
} from "./feedback-report.js";

export { assertValidRunId } from "./runid.js";

export type { EnvSource } from "./secrets.js";
export { isKeikoApiKeyEnvName, keikoApiKeySecretValues } from "./secrets.js";

export { canonicalise, sha256Hex, sha256Base64 } from "./hashing.js";

export { sealString, openString, sealBytes, openBytes, isSealed } from "./secretbox.js";

// Shared filesystem-hardening primitives (0o700 dirs / 0o600 files) — one owner for the store/vault
// packages that previously each carried a private copy [GEN-MAINT-COUPLING-005].
export { DIR_MODE, FILE_MODE, ensureDirHardened, chmodIfPresent } from "./fs-hardening.js";

// Shared, fs-agnostic SQLite corruption classifier — the pure subset lifted out of the per-store db
// lifecycles [GEN-DUP-SEMANTIC-019 / GEN-DUP-NEAR-002].
export type { SqliteErrorLike, SqliteErrorUnwrap } from "./sqlite-corruption.js";
export {
  SqliteQuickCheckError,
  sqliteErrorLike,
  sqliteErrorText,
  isSqliteCorruptionError,
  errorRecord,
} from "./sqlite-corruption.js";

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
