// Re-export shim: the safe tool-execution layer lives in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/index.js"`) keep
// resolving unchanged via this barrel.
//
// Explicitly enumerated to match the PRE-MOVE surface of `src/tools/index.ts`. Browser CDP
// symbols (CdpClient, validators, BrowserToolError, BrowserSessionManager, etc.) are
// deliberately ABSENT from this barrel — they were only ever accessible via
// `src/tools/browser/index.ts` before the extraction, and the legacy shim there preserves
// that surface. Mirrors the workspace shim asymmetry pattern (`nodeWorkspaceFs` not exposed
// on the legacy workspace barrel) so a future SDK-leak test can pin this invariant.
export { DEFAULT_COMMAND_RULES, DEFAULT_ENV_ALLOWLIST, DEFAULT_PATCH_LIMITS, DEFAULT_SANDBOX_POLICY, DEFAULT_TOOL_HOST_CONFIG, resolveToolHostConfig, } from "@oscharko-dev/keiko-tools";
export { CommandCancelledError, CommandDeniedError, CommandTimeoutError, OutputLimitError, PatchApplyDisabledError, PatchApplyError, PatchValidationError, TOOL_CODES, ToolArgumentError, ToolError, UnknownToolError, } from "@oscharko-dev/keiko-tools";
export { buildSandboxEnv, collectSensitiveEnvValues, isCommandAllowed, } from "@oscharko-dev/keiko-tools";
export { nodeWorkspaceWriter } from "@oscharko-dev/keiko-tools/internal/writer";
export { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
export { runCommand, } from "@oscharko-dev/keiko-tools";
export { applyPatch, renderDryRun, validatePatch, } from "@oscharko-dev/keiko-tools";
export { normalizeUnifiedDiffHunks } from "@oscharko-dev/keiko-tools";
export { parseUnifiedDiff } from "@oscharko-dev/keiko-tools";
export { TOOL_DEFINITIONS } from "@oscharko-dev/keiko-tools";
export { WorkspaceToolHost } from "@oscharko-dev/keiko-tools";
