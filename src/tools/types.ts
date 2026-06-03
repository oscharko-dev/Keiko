// Re-export shim: tool contract types + frozen defaults + resolveToolHostConfig live in
// @oscharko-dev/keiko-tools (issue #162, ADR-0019). All existing import sites
// (`from "../tools/types.js"`) keep resolving unchanged via this barrel.

export {
  DEFAULT_COMMAND_RULES,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_TOOL_HOST_CONFIG,
  resolveToolHostConfig,
} from "@oscharko-dev/keiko-tools";
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
} from "@oscharko-dev/keiko-tools";
