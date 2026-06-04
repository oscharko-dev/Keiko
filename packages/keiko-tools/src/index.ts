// Public barrel for @oscharko-dev/keiko-tools — the safe tool-execution layer (ADR-0006 + ADR-
// 0017). Combines the root tool host surface (errors, sandbox, exec, patch, registry, schemas,
// writer, terminal-policy, types) with the browser CDP sub-surface (validators, cdp-client,
// errors, session, types). The browser surface lives behind a per-file shim at
// `src/tools/browser/index.ts` so cross-tree callers (src/ui/browser.ts, src/ui/deps.ts) keep
// their `../tools/browser/index.js` imports unchanged via that shim. No subpath export.

// ─── Tool host contract types + frozen defaults + resolver ──────────────────────────
export type {
  CommandResult,
  CommandRule,
  CommandRunInput,
  NetworkPolicy,
  PatchApplyResult,
  PatchChangeKind,
  PatchConflict,
  PatchFileChange,
  PatchHunk,
  PatchLimits,
  PatchRejection,
  PatchRejectionCode,
  PatchValidation,
  SandboxPolicy,
  ToolHostConfig,
  ToolHostConfigInput,
} from "./types.js";
export {
  DEFAULT_COMMAND_RULES,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_TOOL_HOST_CONFIG,
  resolveToolHostConfig,
} from "./types.js";

// ─── Tool error taxonomy (re-exported from keiko-security; package-self-contained) ──
export {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  OutputLimitError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
  TOOL_CODES,
  ToolArgumentError,
  ToolError,
  UnknownToolError,
  type ToolCode,
} from "./errors.js";

// ─── Sandbox decisions + env build + command allowlist ──────────────────────────────
export {
  buildSandboxEnv,
  collectSensitiveEnvValues,
  isCommandAllowed,
  type CommandDecision,
} from "./sandbox.js";

// ─── WorkspaceWriter port type (Node adapter lives on the internal subpath) ─────────
export type { WorkspaceWriter } from "./writer.js";

// ─── Command execution boundary ─────────────────────────────────────────────────────
export {
  runCommand,
  type ExecutableResolver,
  type ExecutableResolverDeps,
  type HomeProvider,
  type RunCommandDeps,
  type RunCommandInput,
  type SpawnFn,
  type SpawnOptions,
} from "./exec.js";

// ─── Patch workflow ─────────────────────────────────────────────────────────────────
export {
  applyPatch,
  renderDryRun,
  validatePatch,
  type ApplyDeps,
  type ValidateDeps,
} from "./patch.js";
export { normalizeUnifiedDiffHunks } from "./patch-normalize.js";
export { parseUnifiedDiff, PatchParseError, type ParsedPatch } from "./patch-parse.js";
export { computeFileContent, type ApplyOutcome, type HunkConflict } from "./patch-content.js";

// ─── Tool definitions (model-facing JSON-Schema table) ──────────────────────────────
export { TOOL_DEFINITIONS } from "./schemas.js";

// ─── Tool host implementation ───────────────────────────────────────────────────────
export { WorkspaceToolHost } from "./registry.js";

// ─── Terminal-policy: command-allowlist gate used by the terminal BFF ───────────────
// `terminal-policy.ts` re-exports the symbol surface src/ui/terminal.ts depends on. Surface
// every name it exports so the shim at src/tools/terminal-policy.ts can forward from here.
export * from "./terminal-policy.js";

// ─── Browser sub-surface (ADR-0017) ─────────────────────────────────────────────────
export { BROWSER_ERROR_CODES, BrowserToolError, type BrowserErrorCode } from "./browser/errors.js";
export {
  isLoopbackHost,
  isLoopbackUrl,
  normalizeCdpPort,
  normalizeNavigateUrl,
} from "./browser/validators.js";
export type {
  BrowserContentResult,
  BrowserNavigateResult,
  BrowserScreenshotPersisted,
  BrowserScreenshotPreview,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  BrowserSessionStatus,
  BrowserViewportPx,
  CdpReachability,
  NormalizedNavigateUrl,
} from "./browser/types.js";
export {
  CdpClient,
  PERMITTED_CDP_METHODS,
  type CdpCloseListener,
  type CdpClientOptions,
  type CdpEventListener,
} from "./browser/cdp-client.js";
export {
  createBrowserSessionManager,
  type BrowserEventEmitter,
  type BrowserEventEnvelope,
  type BrowserEventKind,
  type BrowserSessionManager,
  type BrowserSessionManagerOptions,
  type BrowserSideFileWriter,
} from "./browser/session.js";

// ─── Package version ────────────────────────────────────────────────────────────────
export { KEIKO_TOOLS_VERSION } from "./version.js";
