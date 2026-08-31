// Public barrel for @oscharko-dev/keiko-security. Re-exports every shared primitive so callers
// can `import { redact, GatewayError, assertValidRunId, sha256Hex } from "@oscharko-dev/keiko-security"`
// without knowing which sub-module owns the symbol. Subpath imports (`./errors/gateway`, etc.) are
// available for callers who want to pull in a narrower surface — both flat and subpath imports
// resolve to the same module instance.

export { KEIKO_SECURITY_VERSION } from "./version.js";

export {
  redact,
  containsCredentialShape,
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

// Shared filesystem-hardening primitives (0o700 dirs / 0o600 files) — one owner for the store/vault
// packages that previously each carried a private copy [GEN-MAINT-COUPLING-005].
export { DIR_MODE, FILE_MODE, ensureDirHardened, chmodIfPresent } from "./fs-hardening.js";

// Shared, bounded macOS Keychain key tier — one owner for the vault surfaces that previously each
// carried a private copy of the same unbounded `security` spawn [GEN-MAINT-COUPLING-006].
export type { MacosKeychainOptions, MacosKeychainRead } from "./macos-keychain.js";
export {
  KEYCHAIN_SPAWN_TIMEOUT_MS,
  readMacosKeychainSecret,
  writeMacosKeychainSecret,
} from "./macos-keychain.js";

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

// Content-free activity-log seam for this package (ADR-0019, w4a-security-log-port) — independent
// of `keiko-local-knowledge`'s `KnowledgeLogSink`. Wired into `readMacosKeychainSecret`,
// `createShardedLocalSecretVault`'s shard reads, and `LocalSecretVault.setMany`. The composition
// root supplies the real sink.
export type { SecurityLogEvent, SecurityLogSink } from "./log-port.js";
export { emitSecurityLogEvent, nullSecurityLogSink, securityErrorKind } from "./log-port.js";

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

// The ONE trusted Windows system-directory decision, shared with keiko-tools (PR #3354 review):
// keiko-tools depends on keiko-security, never the reverse, so this is the only layer both the
// cscript/powershell helpers here and the cmd.exe/taskkill.exe resolution there can reach.
export {
  DEFAULT_WINDOWS_SYSTEM_ROOT,
  WINDOWS_CMD_METACHARACTER_SOURCE,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
  resolveWindowsSystemExecutable,
  sameWindowsSystemDirectoryIdentity,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "./windows-system-directory.js";
export type {
  WindowsBinaryExistsCheck,
  WindowsSystemDirectoryIdentityCheck,
} from "./windows-system-directory.js";
export type {
  WindowsShortcutCommandOptions,
  WindowsShortcutDefinition,
  WindowsShortcutSpawnFn,
} from "./windows-shortcuts.js";
export {
  WINDOWS_SHORTCUT_MAX_BYTES,
  WINDOWS_SHORTCUT_TIMEOUT_MS,
  equivalentWindowsShortcutPath,
  windowsSystemRoot,
  parseWindowsShortcutFallback,
  readWindowsShortcutDefinition,
  runWindowsShortcutCommand,
  windowsShortcutFallbackContent,
  writeWindowsShortcutDefinition,
} from "./windows-shortcuts.js";

export * from "./errors/index.js";
