// Public barrel for the safe tool-execution layer (ADR-0006). The tool host is the trust
// boundary between model output and developer repositories: deny-by-default command allowlist,
// env-isolated no-shell spawn, and a fail-closed, atomic patch workflow. Explicit named
// re-exports, `type` keyword for type-only, double quotes, `.js`.

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

export {
  buildSandboxEnv,
  collectSensitiveEnvValues,
  isCommandAllowed,
  type CommandDecision,
} from "./sandbox.js";

export { nodeWorkspaceWriter, type WorkspaceWriter } from "./writer.js";

export {
  nodeSpawnFn,
  runCommand,
  type RunCommandDeps,
  type RunCommandInput,
  type ExecutableResolver,
  type ExecutableResolverDeps,
  type SpawnFn,
  type SpawnOptions,
} from "./exec.js";

export {
  applyPatch,
  renderDryRun,
  validatePatch,
  type ApplyDeps,
  type ValidateDeps,
} from "./patch.js";

export { normalizeUnifiedDiffHunks } from "./patch-normalize.js";
export { parseUnifiedDiff, type ParsedPatch } from "./patch-parse.js";

export { TOOL_DEFINITIONS } from "./schemas.js";

export { WorkspaceToolHost } from "./registry.js";
