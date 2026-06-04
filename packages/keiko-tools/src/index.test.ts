// Public-surface pin test, mirroring keiko-workspace/src/index.test.ts. Every symbol that lives
// on the package's main entry point is touched here so a future refactor that accidentally drops
// a named export — or downgrades a value to a type-only re-export — fails this test instead of
// silently breaking a downstream caller. The trust-boundary nature of this package (it owns the
// only safe-tool-execution surface) makes the "stable public surface" guarantee load-bearing.

import { describe, expect, it } from "vitest";
import * as tools from "./index.js";
import type {
  ApplyDeps,
  ApplyOutcome,
  CommandDecision,
  CommandResult,
  CommandRule,
  CommandRunInput,
  ExecutableResolver,
  ExecutableResolverDeps,
  HomeProvider,
  HunkConflict,
  NetworkPolicy,
  ParsedPatch,
  PatchApplyResult,
  PatchChangeKind,
  PatchConflict,
  PatchFileChange,
  PatchHunk,
  PatchLimits,
  PatchRejection,
  PatchRejectionCode,
  PatchValidation,
  RunCommandDeps,
  RunCommandInput,
  SandboxPolicy,
  SpawnFn,
  SpawnOptions,
  ToolCode,
  ToolHostConfig,
  ToolHostConfigInput,
  ValidateDeps,
  WorkspaceWriter,
  BrowserContentResult,
  BrowserErrorCode,
  BrowserEventEmitter,
  BrowserEventEnvelope,
  BrowserEventKind,
  BrowserNavigateResult,
  BrowserScreenshotPersisted,
  BrowserScreenshotPreview,
  BrowserScreenshotResult,
  BrowserSessionManager,
  BrowserSessionManagerOptions,
  BrowserSessionMeta,
  BrowserSessionStatus,
  BrowserSideFileWriter,
  BrowserViewportPx,
  CdpClientOptions,
  CdpCloseListener,
  CdpEventListener,
  CdpReachability,
  NormalizedNavigateUrl,
  TerminalCommandDecision,
} from "./index.js";

describe("keiko-tools public surface", () => {
  it("exposes the documented value barrel members", () => {
    expect(tools.KEIKO_TOOLS_VERSION).toBe("0.1.0");
    // Frozen default tables (re-exported from contracts):
    expect(tools.DEFAULT_COMMAND_RULES).toBeDefined();
    expect(tools.DEFAULT_ENV_ALLOWLIST).toBeDefined();
    expect(tools.DEFAULT_PATCH_LIMITS).toBeDefined();
    expect(tools.DEFAULT_SANDBOX_POLICY).toBeDefined();
    expect(tools.DEFAULT_TOOL_HOST_CONFIG).toBeDefined();
    expect(typeof tools.resolveToolHostConfig).toBe("function");
    // Tool errors:
    expect(tools.TOOL_CODES).toBeDefined();
    expect(typeof tools.ToolError).toBe("function");
    expect(typeof tools.ToolArgumentError).toBe("function");
    expect(typeof tools.UnknownToolError).toBe("function");
    expect(typeof tools.CommandDeniedError).toBe("function");
    expect(typeof tools.CommandTimeoutError).toBe("function");
    expect(typeof tools.CommandCancelledError).toBe("function");
    expect(typeof tools.OutputLimitError).toBe("function");
    expect(typeof tools.PatchValidationError).toBe("function");
    expect(typeof tools.PatchApplyDisabledError).toBe("function");
    expect(typeof tools.PatchApplyError).toBe("function");
    // Sandbox + writer:
    expect(typeof tools.buildSandboxEnv).toBe("function");
    expect(typeof tools.collectSensitiveEnvValues).toBe("function");
    expect(typeof tools.isCommandAllowed).toBe("function");
    expect(tools).not.toHaveProperty("nodeWorkspaceWriter");
    // Exec:
    expect(tools).not.toHaveProperty("nodeHomeProvider");
    expect(tools).not.toHaveProperty("nodeSpawnFn");
    expect(typeof tools.runCommand).toBe("function");
    // Patch:
    expect(typeof tools.applyPatch).toBe("function");
    expect(typeof tools.renderDryRun).toBe("function");
    expect(typeof tools.validatePatch).toBe("function");
    expect(typeof tools.normalizeUnifiedDiffHunks).toBe("function");
    expect(typeof tools.parseUnifiedDiff).toBe("function");
    expect(typeof tools.PatchParseError).toBe("function");
    expect(typeof tools.computeFileContent).toBe("function");
    // Schemas + registry:
    expect(tools.TOOL_DEFINITIONS).toBeDefined();
    expect(typeof tools.WorkspaceToolHost).toBe("function");
    // Terminal policy:
    expect(tools.TERMINAL_COMMAND_RULES).toBeDefined();
    expect(tools.TERMINAL_NO_FLAGS).toBeDefined();
    expect(typeof tools.isTerminalCommandAllowed).toBe("function");
    // Browser:
    expect(tools.BROWSER_ERROR_CODES).toBeDefined();
    expect(typeof tools.BrowserToolError).toBe("function");
    expect(typeof tools.isLoopbackHost).toBe("function");
    expect(typeof tools.isLoopbackUrl).toBe("function");
    expect(typeof tools.normalizeCdpPort).toBe("function");
    expect(typeof tools.normalizeNavigateUrl).toBe("function");
    expect(typeof tools.CdpClient).toBe("function");
    expect(tools.PERMITTED_CDP_METHODS).toBeDefined();
    expect(typeof tools.createBrowserSessionManager).toBe("function");
  });

  it("each type-only export is reachable by name at compile time", () => {
    // verbatimModuleSyntax requires the type imports above to be used in a type position. A
    // phantom generic `pin<T>()` references the type argument at the call site without producing
    // any runtime value, so each symbol stays load-bearing on the public surface.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<ApplyDeps>();
    pin<ApplyOutcome>();
    pin<CommandDecision>();
    pin<CommandResult>();
    pin<CommandRule>();
    pin<CommandRunInput>();
    pin<ExecutableResolver>();
    pin<ExecutableResolverDeps>();
    pin<HomeProvider>();
    pin<HunkConflict>();
    pin<NetworkPolicy>();
    pin<ParsedPatch>();
    pin<PatchApplyResult>();
    pin<PatchChangeKind>();
    pin<PatchConflict>();
    pin<PatchFileChange>();
    pin<PatchHunk>();
    pin<PatchLimits>();
    pin<PatchRejection>();
    pin<PatchRejectionCode>();
    pin<PatchValidation>();
    pin<RunCommandDeps>();
    pin<RunCommandInput>();
    pin<SandboxPolicy>();
    pin<SpawnFn>();
    pin<SpawnOptions>();
    pin<ToolCode>();
    pin<ToolHostConfig>();
    pin<ToolHostConfigInput>();
    pin<ValidateDeps>();
    pin<WorkspaceWriter>();
    pin<BrowserContentResult>();
    pin<BrowserErrorCode>();
    pin<BrowserEventEmitter>();
    pin<BrowserEventEnvelope>();
    pin<BrowserEventKind>();
    pin<BrowserNavigateResult>();
    pin<BrowserScreenshotPersisted>();
    pin<BrowserScreenshotPreview>();
    pin<BrowserScreenshotResult>();
    pin<BrowserSessionManager>();
    pin<BrowserSessionManagerOptions>();
    pin<BrowserSessionMeta>();
    pin<BrowserSessionStatus>();
    pin<BrowserSideFileWriter>();
    pin<BrowserViewportPx>();
    pin<CdpClientOptions>();
    pin<CdpCloseListener>();
    pin<CdpEventListener>();
    pin<CdpReachability>();
    pin<NormalizedNavigateUrl>();
    pin<TerminalCommandDecision>();
  });
});
