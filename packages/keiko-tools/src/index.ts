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
  FilesystemPolicy,
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
  buildRestorePatch,
  inspectPatch,
  invertPatch,
  projectValidatedPatch,
  renderDryRun,
  validatePatch,
  type ApplyDeps,
  type PatchInspection,
  type PatchInspectionFile,
  type ValidateDeps,
} from "./patch.js";
export { normalizeUnifiedDiffHunks } from "./patch-normalize.js";
export { parseUnifiedDiff, PatchParseError, type ParsedPatch } from "./patch-parse.js";
export { computeFileContent, type ApplyOutcome, type HunkConflict } from "./patch-content.js";

// ─── Tool definitions (model-facing JSON-Schema table) ──────────────────────────────
export { TOOL_DEFINITIONS } from "./schemas.js";
export { EDITOR_AGENT_TOOL_DEFINITIONS } from "./editor-agent-schemas.js";

// ─── Tool host implementation ───────────────────────────────────────────────────────
export { WorkspaceToolHost } from "./registry.js";
export {
  DEFAULT_EDITOR_AGENT_HTTP_TIMEOUT_MS,
  DEFAULT_EDITOR_AGENT_MAX_RESPONSE_BYTES,
  DEFAULT_EDITOR_AGENT_VERIFICATION_TIMEOUT_MS,
  EditorAgentHttpClient,
  createFetchEditorAgentHttpTransport,
  type EditorAgentClientError,
  type EditorAgentClientErrorKind,
  type EditorAgentClientResult,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentHttpTransportResponse,
  type EditorAgentTimeoutScheduler,
} from "./editor-agent-client.js";
export { EditorAgentToolHost, type EditorAgentToolOutput } from "./editor-agent-tool-host.js";

// ─── Terminal-policy: command-allowlist gate used by the terminal BFF ───────────────
// `terminal-policy.ts` re-exports the symbol surface src/ui/terminal.ts depends on. Surface
// every name it exports so the shim at src/tools/terminal-policy.ts can forward from here.
export * from "./terminal-policy.js";

// ─── Governed Git mutation execution kernel (Issue #472, Epic #470) ──────────────────
// The deterministic preflight/orchestration kernel for governed local Git writes. The Node
// execution adapter lives on the `./internal/git-mutation` subpath (it carries the spawn effect);
// the pure surface — lifecycle taxonomy, preflight evaluators, the narrow adapter port + closed
// command table, and the orchestrator — is re-exported here.
export {
  GIT_MUTATION_FAILURE_CATEGORIES,
  GIT_MUTATION_LIFECYCLE_PHASES,
  GIT_MUTATION_PHASE_ORDER,
  GIT_MUTATION_STATUSES,
  gitMutationCategoryForExecutionError,
  gitMutationCategoryForExecutionResult,
  gitMutationFailureIsRecoverable,
  isGitMutationFailureCategory,
  isGitMutationLifecyclePhase,
  isGitMutationStatus,
  type GitMutationFailureCategory,
  type GitMutationLifecyclePhase,
  type GitMutationStatus,
} from "./git-mutation-taxonomy.js";
export {
  evaluateGitPreflight,
  GIT_PREFLIGHT_FINDING_CODES,
  gitPreflightRemediationFor,
  isGitPreflightFindingCode,
  type GitPreflightFinding,
  type GitPreflightFindingCode,
  type GitPreflightRemediation,
  type GitPreflightReport,
  type GitPreflightSeverity,
  type GitWorktreeSnapshot,
} from "./git-mutation-preflight.js";
export {
  buildAbortArgv,
  buildBranchCreateArgv,
  buildBranchSwitchArgv,
  buildCommitArgv,
  buildRecoveryArgv,
  buildStageArgv,
  buildUnstageArgv,
  GIT_MUTATION_ALLOWED_SUBCOMMANDS,
  GIT_MUTATION_COMMAND_RULES,
  gitMutationPlanIsGoverned,
  GitMutationArgvError,
  type GitAbortExecRequest,
  type GitBranchCreateExecRequest,
  type GitBranchSwitchExecRequest,
  type GitCommitExecRequest,
  type GitLocalMutationAdapter,
  type GitMutationArgvPlan,
  type GitRecoveryExecRequest,
  type GitStageExecRequest,
  type GitUnstageExecRequest,
} from "./git-mutation-adapter.js";
export {
  createInMemoryGitMutationJournal,
  gitMutationOutcomeFailureCategory,
  runGitMutation,
  type GitAbortCommand,
  type GitBranchCreateCommand,
  type GitBranchSwitchCommand,
  type GitCommitCommand,
  type GitMutationCommand,
  type GitMutationJournal,
  type GitMutationLifecycleResult,
  type GitMutationOrchestratorDeps,
  type GitMutationOutcome,
  type GitMutationRequest,
  type GitRecoveryCommand,
  type GitStageCommand,
  type GitUnstageCommand,
} from "./git-mutation-orchestrator.js";
export {
  buildGitDeliveryEvidenceRecord,
  type GitDeliveryEvidenceBuildDeps,
  type GitDeliveryEvidenceBuildInput,
  type GitDeliveryEvidenceSnapshot,
} from "./git-mutation-evidence.js";

// ─── Governed remote publish gateway (Issue #476, Epic #470; ADR-0063) ──────────────────────────
// The SEPARATE remote execution authority for governed push. The pure surface — push command, narrow
// remote adapter port, dedicated push allowlist, argv builder, rejection taxonomy, and the runGitPublish
// orchestrator — is re-exported here. The Node push executor (createNodeGitPublishAdapter) carries the
// spawn effect and is reachable on the `./internal/git-mutation` subpath, alongside the other Node git
// effects, never the package barrel.
export {
  buildPushArgv,
  classifyGitPublishRejection,
  evaluateGitPublishEffectivePolicy,
  GIT_PUBLISH_ALLOWED_SUBCOMMANDS,
  GIT_PUBLISH_COMMAND_RULES,
  GIT_PUBLISH_REJECTION_REASONS,
  gitPublishArgvIsGoverned,
  gitPublishRejectionFor,
  gitPublishRejectionToErrorCode,
  GitPublishArgvError,
  isGitPublishRejectionReason,
  runGitPublish,
  type GitPublishEffectivePolicy,
  type GitPublishExecRequest,
  type GitPublishExecResult,
  type GitPublishLifecycleResult,
  type GitPublishOrchestratorDeps,
  type GitPublishRejection,
  type GitPublishRejectionReason,
  type GitPublishRequest,
  type GitPushCommand,
  type GitRemotePublishAdapter,
} from "./git-publish-gateway.js";

// The SEPARATE GitHub pull request authority (Issue #477, ADR-0064). A PARALLEL gateway to the publish
// gateway — never an extension of it. The pure surface — PR command union, narrow two-method adapter
// port, dedicated `gh api` allowlist, argv builders, GitHub-error classifier, effective-policy
// evaluator, and the runGitPullRequest orchestrator — is re-exported here. The Node `gh api` executor
// (createNodeGitPullRequestAdapter) carries the spawn effect and is reachable on the
// `./internal/git-mutation` subpath, never the package barrel.
export {
  buildPrConvertDraftGraphqlArgv,
  buildPrCreateArgv,
  buildPrMarkReadyGraphqlArgv,
  buildPrUpdateArgv,
  classifyGitPullRequestRejection,
  evaluateGitPullRequestEffectivePolicy,
  GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS,
  GIT_PULL_REQUEST_COMMAND_RULES,
  gitPrArgvIsGoverned,
  gitPrRejectionToErrorCode,
  gitPullRequestRejectionFor,
  GitPrArgvError,
  runGitPullRequest,
  type GitPrCreateCommand,
  type GitPrCreateExecRequest,
  type GitPrExecResult,
  type GitPrUpdateCommand,
  type GitPrUpdateExecRequest,
  type GitPullRequestAdapter,
  type GitPullRequestCommand,
  type GitPullRequestEffectivePolicy,
  type GitPullRequestLifecycleResult,
  type GitPullRequestOrchestratorDeps,
  type GitPullRequestRejection,
  type GitPullRequestRequest,
} from "./git-pr-gateway.js";

// The SEPARATE governed merge authority (Issue #478, ADR-0087). A THIRD parallel gateway to the publish
// and PR gateways — never an extension of either. The pure surface — merge command, narrow two-method
// adapter port (readiness read + merge execute), dedicated `gh api` allowlist, argv builders, GitHub
// merge-error classifier, mergeable-state mapper, effective-policy evaluator, and the runGitMerge
// orchestrator (preflight + policy + final-approval + the readiness gate) — is re-exported here. The Node
// `gh api` executor (createNodeGitMergeAdapter) carries the spawn effect and is reachable on the
// `./internal/git-mutation` subpath, never the package barrel.
export {
  buildDeleteMergedBranchArgv,
  buildHeadStatusArgv,
  buildMergeArgv,
  buildMergeReadinessArgv,
  buildRepoMergeConfigArgv,
  classifyGitMergeRejection,
  evaluateGitMergeEffectivePolicy,
  GIT_MERGE_ALLOWED_SUBCOMMANDS,
  GIT_MERGE_COMMAND_RULES,
  gitMergeArgvIsGoverned,
  gitMergeRejectionToErrorCode,
  GitMergeArgvError,
  mapRawMergeReadiness,
  runGitMerge,
  type GitMergeAdapter,
  type GitMergeCommand,
  type GitMergeEffectivePolicy,
  type GitMergeExecRequest,
  type GitMergeExecResult,
  type GitMergeLifecycleResult,
  type GitMergeOrchestratorDeps,
  type GitMergeProviderReadiness,
  type GitMergeReadinessRequest,
  type GitMergeRequest,
  type RawMergeReadiness,
} from "./git-merge-gateway.js";

// ─── Governed local Git flows: commit-intent summary (Issue #475) ──────────────────────────────
// The PURE commit-intent summarizer reduces staged paths into the content-free GitCommitChangeSummary.
// The live worktree READER carries the Node spawn effect and is therefore NOT re-exported here; it is
// reachable via the `./internal/git-mutation` subpath (alongside createNodeGitMutationAdapter).
export { MAX_COMMIT_SUMMARY_AREAS, summarizeStagedChangeset } from "./git-commit-intent-node.js";

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
