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
  FilesystemPolicy,
  HomeProvider,
  HunkConflict,
  NetworkPolicy,
  ParsedPatch,
  PatchApplyResult,
  PatchChangeKind,
  PatchConflict,
  PatchFileChange,
  PatchHunk,
  PatchInspection,
  PatchInspectionFile,
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
  GitMutationFailureCategory,
  GitMutationLifecyclePhase,
  GitMutationStatus,
  GitPreflightFinding,
  GitPreflightFindingCode,
  GitPreflightRemediation,
  GitPreflightReport,
  GitPreflightSeverity,
  GitWorktreeSnapshot,
  GitAbortExecRequest,
  GitBranchCreateExecRequest,
  GitCommitExecRequest,
  GitLocalMutationAdapter,
  GitMutationArgvPlan,
  GitRecoveryExecRequest,
  GitStageExecRequest,
  GitUnstageExecRequest,
  GitAbortCommand,
  GitBranchCreateCommand,
  GitCommitCommand,
  GitMutationCommand,
  GitMutationJournal,
  GitMutationLifecycleResult,
  GitMutationOrchestratorDeps,
  GitMutationOutcome,
  GitMutationRequest,
  GitRecoveryCommand,
  GitStageCommand,
  GitUnstageCommand,
  EditorAgentClientError,
  EditorAgentClientErrorKind,
  EditorAgentClientResult,
  EditorAgentHttpTransport,
  EditorAgentHttpTransportRequest,
  EditorAgentHttpTransportResponse,
  EditorAgentTimeoutScheduler,
  EditorAgentToolOutput,
} from "./index.js";

describe("keiko-tools public surface", () => {
  it("exposes the documented value barrel members", () => {
    expect(tools.KEIKO_TOOLS_VERSION).toBe("0.2.15");
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
    expect(typeof tools.buildRestorePatch).toBe("function");
    expect(typeof tools.inspectPatch).toBe("function");
    expect(typeof tools.renderDryRun).toBe("function");
    expect(typeof tools.validatePatch).toBe("function");
    expect(typeof tools.projectValidatedPatch).toBe("function");
    expect(typeof tools.normalizeUnifiedDiffHunks).toBe("function");
    expect(typeof tools.parseUnifiedDiff).toBe("function");
    expect(typeof tools.PatchParseError).toBe("function");
    expect(typeof tools.computeFileContent).toBe("function");
    // Schemas + registry:
    expect(tools.TOOL_DEFINITIONS).toBeDefined();
    expect(typeof tools.WorkspaceToolHost).toBe("function");
    expect(tools.EDITOR_AGENT_TOOL_DEFINITIONS).toHaveLength(8);
    expect(typeof tools.EditorAgentHttpClient).toBe("function");
    expect(typeof tools.createFetchEditorAgentHttpTransport).toBe("function");
    expect(typeof tools.EditorAgentToolHost).toBe("function");
    expect(tools.DEFAULT_EDITOR_AGENT_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(tools.DEFAULT_EDITOR_AGENT_MAX_RESPONSE_BYTES).toBeGreaterThan(0);
    expect(tools.DEFAULT_EDITOR_AGENT_VERIFICATION_TIMEOUT_MS).toBeGreaterThan(
      tools.DEFAULT_EDITOR_AGENT_HTTP_TIMEOUT_MS,
    );
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
    // Governed Git mutation kernel (#472) — taxonomy:
    expect(tools.GIT_MUTATION_FAILURE_CATEGORIES).toBeDefined();
    expect(tools.GIT_MUTATION_LIFECYCLE_PHASES).toBeDefined();
    expect(tools.GIT_MUTATION_PHASE_ORDER).toBeDefined();
    expect(tools.GIT_MUTATION_STATUSES).toBeDefined();
    expect(typeof tools.gitMutationCategoryForExecutionError).toBe("function");
    expect(typeof tools.gitMutationCategoryForExecutionResult).toBe("function");
    expect(typeof tools.gitMutationFailureIsRecoverable).toBe("function");
    expect(typeof tools.isGitMutationFailureCategory).toBe("function");
    expect(typeof tools.isGitMutationLifecyclePhase).toBe("function");
    expect(typeof tools.isGitMutationStatus).toBe("function");
    // Preflight:
    expect(typeof tools.evaluateGitPreflight).toBe("function");
    expect(tools.GIT_PREFLIGHT_FINDING_CODES).toBeDefined();
    expect(typeof tools.gitPreflightRemediationFor).toBe("function");
    expect(typeof tools.isGitPreflightFindingCode).toBe("function");
    // Narrow adapter port + closed command table:
    expect(typeof tools.buildAbortArgv).toBe("function");
    expect(typeof tools.buildBranchCreateArgv).toBe("function");
    expect(typeof tools.buildBranchSwitchArgv).toBe("function");
    expect(typeof tools.buildCommitArgv).toBe("function");
    expect(typeof tools.buildRecoveryArgv).toBe("function");
    expect(typeof tools.buildStageArgv).toBe("function");
    expect(typeof tools.buildUnstageArgv).toBe("function");
    expect(tools.GIT_MUTATION_ALLOWED_SUBCOMMANDS).toBeDefined();
    expect(tools.GIT_MUTATION_COMMAND_RULES).toBeDefined();
    expect(typeof tools.gitMutationPlanIsGoverned).toBe("function");
    expect(typeof tools.GitMutationArgvError).toBe("function");
    // Orchestrator:
    expect(typeof tools.createInMemoryGitMutationJournal).toBe("function");
    expect(typeof tools.gitMutationOutcomeFailureCategory).toBe("function");
    expect(typeof tools.runGitMutation).toBe("function");
    // The Node execution adapter is NOT on the main barrel — it lives on ./internal/git-mutation.
    expect(tools).not.toHaveProperty("createNodeGitMutationAdapter");
    // #475: the pure commit-intent summarizer IS on the barrel; the spawn-effect reader is NOT (it
    // is reachable via ./internal/git-mutation alongside the Node adapter).
    expect(typeof tools.summarizeStagedChangeset).toBe("function");
    expect(tools.MAX_COMMIT_SUMMARY_AREAS).toBeDefined();
    expect(tools).not.toHaveProperty("readGitWorktreeSnapshot");
  });

  it("exposes the editor agent host types", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<EditorAgentClientError>();
    pin<EditorAgentClientErrorKind>();
    pin<EditorAgentClientResult<unknown>>();
    pin<EditorAgentHttpTransport>();
    pin<EditorAgentHttpTransportRequest>();
    pin<EditorAgentHttpTransportResponse>();
    pin<EditorAgentTimeoutScheduler>();
    pin<EditorAgentToolOutput>();
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
    pin<FilesystemPolicy>();
    pin<HomeProvider>();
    pin<HunkConflict>();
    pin<NetworkPolicy>();
    pin<ParsedPatch>();
    pin<PatchApplyResult>();
    pin<PatchChangeKind>();
    pin<PatchConflict>();
    pin<PatchFileChange>();
    pin<PatchHunk>();
    pin<PatchInspection>();
    pin<PatchInspectionFile>();
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
    pin<GitMutationFailureCategory>();
    pin<GitMutationLifecyclePhase>();
    pin<GitMutationStatus>();
    pin<GitPreflightFinding>();
    pin<GitPreflightFindingCode>();
    pin<GitPreflightRemediation>();
    pin<GitPreflightReport>();
    pin<GitPreflightSeverity>();
    pin<GitWorktreeSnapshot>();
    pin<GitAbortExecRequest>();
    pin<GitBranchCreateExecRequest>();
    pin<GitCommitExecRequest>();
    pin<GitLocalMutationAdapter>();
    pin<GitMutationArgvPlan>();
    pin<GitRecoveryExecRequest>();
    pin<GitStageExecRequest>();
    pin<GitUnstageExecRequest>();
    pin<GitAbortCommand>();
    pin<GitBranchCreateCommand>();
    pin<GitCommitCommand>();
    pin<GitMutationCommand>();
    pin<GitMutationJournal>();
    pin<GitMutationLifecycleResult>();
    pin<GitMutationOrchestratorDeps>();
    pin<GitMutationOutcome>();
    pin<GitMutationRequest>();
    pin<GitRecoveryCommand>();
    pin<GitStageCommand>();
    pin<GitUnstageCommand>();
  });
});
