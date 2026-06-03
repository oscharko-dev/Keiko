// Re-export shim: tool contract types and frozen default tables live in
// @oscharko-dev/keiko-contracts (issue #158). The `resolveToolHostConfig` runtime helper STAYS
// here because contracts contains type/data only — no runtime functions. `verbatimModuleSyntax`
// is on, so type-only names use `export type` and value-emitting frozen constants use `export`.

import {
  DEFAULT_TOOL_HOST_CONFIG,
  type ToolHostConfig,
  type ToolHostConfigInput,
} from "@oscharko-dev/keiko-contracts";

export type {
  NetworkPolicy,
  SandboxPolicy,
  CommandRule,
  CommandRunInput,
  CommandResult,
  PatchChangeKind,
  PatchHunk,
  PatchFileChange,
  PatchRejectionCode,
  PatchRejection,
  PatchConflict,
  PatchValidation,
  PatchLimits,
  PatchApplyResult,
  ToolHostConfig,
  ToolHostConfigInput,
} from "@oscharko-dev/keiko-contracts";
export {
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_COMMAND_RULES,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_TOOL_HOST_CONFIG,
} from "@oscharko-dev/keiko-contracts";

// Deep-merges a caller override over the defaults: the nested sandbox/patchLimits objects merge
// field-by-field so a partial override never drops an unspecified default (S-M2).
export function resolveToolHostConfig(input: ToolHostConfigInput | undefined): ToolHostConfig {
  const base = DEFAULT_TOOL_HOST_CONFIG;
  return {
    sandbox: { ...base.sandbox, ...input?.sandbox },
    commandRules: input?.commandRules ?? base.commandRules,
    patchLimits: { ...base.patchLimits, ...input?.patchLimits },
    applyEnabled: input?.applyEnabled ?? base.applyEnabled,
    maxReadBytes: input?.maxReadBytes ?? base.maxReadBytes,
  };
}
