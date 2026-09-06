// Issue #2211 — the editor verification run registry. A bounded, in-memory manager that plans and runs
// `test | targeted-test | typecheck | lint | build` through keiko-verification's
// buildVerificationPlan/planDirectTargetedTests composed with the shared enforce-or-fail-closed
// primitive (verificationExecution.ts), and streams CONTENT-FREE lifecycle events. It structurally
// mirrors CommandRunnerManager (discover/execute/abort/subscribe/inFlightCount, a
// Map<string, InFlightRun> registry, AbortController cancellation) — no second execution pipeline.
//
// Security parity with the command runner: script-backed kinds (test | typecheck | lint | build) run
// arbitrary package.json scripts and require the SAME server-owned workspace-trust decision, defaulting
// fail-closed to `() => false`, exactly as deps.ts's buildCommandRunner wiring does today. targeted-test
// is a Keiko-synthesized `npx vitest/jest run <files>` invocation and is exempt (parity with
// postApplyVerification.ts). Runs always use `networkEnforcement: "enforce-or-fail-closed"`.

import { randomUUID } from "node:crypto";
import type {
  EditorVerificationCatalog,
  EditorVerificationCatalogEntry,
  EditorVerificationEvent,
  EditorVerificationRun,
  EditorVerificationTrustState,
  VerificationKind,
  VerificationPlan,
  VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_VERIFICATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-verification";
import { DEFAULT_RETENTION, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  buildVerificationPlan,
  detectScripts,
  planDirectTargetedTests,
} from "@oscharko-dev/keiko-verification";
import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { resolveTrustBasisFact, trustBasisFactsMatch } from "../workspace-script-trust.js";
import {
  appendEditorVerificationRunEvidence,
  buildEditorVerificationInterruptedEvidenceEntry,
  buildEditorVerificationRunEvidenceEntry,
} from "./verification-run-evidence.js";
import {
  executeVerificationEnforced,
  type ExecuteVerificationArgs,
  type ExecuteVerificationResult,
} from "./verificationExecution.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import type { Project, UiStore } from "../store/index.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import type { ServerLogSink } from "../observability/index.js";
import {
  describeError,
  evidenceRetentionDiagnosticObserver,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const CATALOG_KINDS: readonly VerificationKind[] = [
  "typecheck",
  "lint",
  "test",
  "build",
  "targeted-test",
];

function isScriptBackedKind(kind: VerificationKind): boolean {
  return kind !== "targeted-test";
}

// ─── Public types ─────────────────────────────────────────────────────────────────

export interface VerificationRunInput {
  readonly projectId: string;
  readonly kinds: readonly VerificationKind[];
  readonly targetPath?: string | undefined;
  readonly requestId?: string | undefined;
  // Server-minted request correlation. Never accepted from the parsed client payload.
  readonly correlationId?: string | undefined;
}

export interface VerificationRunStart {
  readonly runId: string;
  readonly run: EditorVerificationRun;
}

export type EditorVerificationCatalogDiscovery = Omit<EditorVerificationCatalog, "workspaceTrust">;

export type VerificationRunnerEventEmitter = (event: EditorVerificationEvent) => void;
export type VerificationRunnerWorkspaceTrustDecider = (
  projectId: string,
  workspace: WorkspaceInfo,
) => boolean;
export type VerificationExecutePort = (
  args: ExecuteVerificationArgs,
) => Promise<ExecuteVerificationResult>;

export interface VerificationRunnerManager {
  readonly discover: (projectId: string) => EditorVerificationCatalogDiscovery;
  readonly execute: (input: VerificationRunInput) => VerificationRunStart;
  // Issue #2214 — synchronous, single-shot run for the agent verification route. Reuses the SAME
  // workspace resolution, plan building (incl. the workspace-trust gate), and enforce-or-fail-closed
  // execution as `execute`, but resolves to the final report instead of streaming events. `signal`
  // (the agent's tool-call signal) aborts the underlying run for early cancellation.
  readonly runToReport: (
    input: VerificationRunInput,
    signal: AbortSignal,
  ) => Promise<VerificationReport>;
  readonly abort: (runId: string) => boolean;
  readonly subscribe: (listener: VerificationRunnerEventEmitter) => () => void;
  readonly inFlightCount: () => number;
}

export interface VerificationRunnerManagerOptions {
  readonly store: UiStore;
  readonly fs?: WorkspaceFs | undefined;
  readonly isWorkspaceTrustedForPackageScripts?:
    VerificationRunnerWorkspaceTrustDecider | undefined;
  readonly now?: (() => number) | undefined;
  // Injectable execution port; tests supply a deterministic report/probe without spawning.
  readonly execute?: VerificationExecutePort | undefined;
  readonly maxConcurrentRuns?: number | undefined;
  // Issue #2211 fix-up (Epic #2092): the audit-evidence trail, mirroring buildCommandRunner's
  // store/evidence/live-redactor construction pattern. Optional (like CommandRunnerManagerOptions)
  // so unit tests may omit it; production wiring (deps.ts) always supplies both.
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly redactor?: ((input: string) => string) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly resolveWorkspaceRootAccess?: VerificationWorkspaceRootAccessResolver | undefined;
}

// The resolver carries the run's own correlation id so ITS refusal line (`workspace.root.denied`,
// emitted inside the production resolver) joins the run that asked for it. Without the second
// argument every denial that refused a verification landed under UNKNOWN_CORRELATION_ID and
// `keiko support analyze --correlation-id <run>` showed the refusal nowhere (PR #3381 review). The
// parameter is optional, so a one-argument resolver (every existing test fake) is still a valid
// substitute.
export type VerificationWorkspaceRootAccessResolver = (
  requestedRoot: string,
  correlationId?: string,
) => WorkspaceRootAccess | undefined;

// ─── Project resolution (private per-module copy, established convention — command-runner.ts:94) ──

function projectFor(store: UiStore, projectId: string): Project | undefined {
  for (const project of store.listProjects()) {
    if (project.path === projectId) return project;
  }
  return undefined;
}

// ─── Manager ─────────────────────────────────────────────────────────────────────

interface InFlightRun {
  readonly controller: AbortController;
  readonly correlationId: string;
  cancelledByUser: boolean;
  terminalEmitted: boolean;
}

interface ResolvedVerificationWorkspace {
  readonly access: WorkspaceRootAccess;
  readonly workspace: WorkspaceInfo;
  // The project whose standing script trust governs this workspace, and that project's own
  // workspace facts: the project itself, or for a managed task worktree the repository it was bound
  // from (the trust decider checks the workspace root against the project root, so a worktree's
  // facts would never match its repository's grant).
  readonly trustProjectId: string;
  readonly trustWorkspace: WorkspaceInfo;
  // The repository root the root that will actually run scripts must STILL match — the roots, not
  // the boolean they compare to. The grant is bound to exact manifest bytes (ADR-0147 D3), so a
  // comparison taken once at resolution time and reused at the effect boundary would accept a
  // `package.json` replaced between the two checks and spawn a script no human approved (P1,
  // PR #3381 review). `trustedForScripts` therefore re-derives the comparison from these roots on
  // every ask, so the at-effect answer is read from the filesystem in the same synchronous step
  // that admits the run. `undefined` for an ordinary root, which is its own basis and has nothing to
  // compare against; a managed access always names one (`WorkspaceRootAccess`'s `managed-task`
  // branch REQUIRES `repositoryRoot`).
  readonly trustBasisRepositoryRoot: string | undefined;
}

interface PreparedVerificationRun {
  readonly resolved: ResolvedVerificationWorkspace;
  readonly plan: VerificationPlan;
}

class VerificationRunnerManagerImpl implements VerificationRunnerManager {
  private readonly store: UiStore;
  private readonly fs: WorkspaceFs;
  private readonly isTrusted: VerificationRunnerWorkspaceTrustDecider;
  private readonly now: () => number;
  private readonly executePort: VerificationExecutePort;
  private readonly maxConcurrentRuns: number;
  private readonly evidenceStore: EvidenceStore | undefined;
  private readonly redactor: (input: string) => string;
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private readonly activityLog: ServerLogSink;
  private readonly rootAccessResolver: VerificationWorkspaceRootAccessResolver | undefined;
  private readonly runs = new Map<string, InFlightRun>();
  private readonly subscribers = new Set<VerificationRunnerEventEmitter>();

  public constructor(opts: VerificationRunnerManagerOptions) {
    this.store = opts.store;
    this.fs = opts.fs ?? nodeWorkspaceFs;
    this.isTrusted = opts.isWorkspaceTrustedForPackageScripts ?? ((): boolean => false);
    this.now = opts.now ?? Date.now;
    this.executePort = opts.execute ?? executeVerificationEnforced;
    this.maxConcurrentRuns = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.evidenceStore = opts.evidenceStore;
    this.redactor = opts.redactor ?? ((input: string): string => input);
    this.diagnostics = opts.diagnostics;
    this.activityLog = opts.activityLog ?? processServerLogSink();
    this.rootAccessResolver = opts.resolveWorkspaceRootAccess;
  }

  public readonly inFlightCount = (): number => this.runs.size;

  public readonly subscribe = (listener: VerificationRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly abort = (runId: string): boolean => {
    const entry = this.runs.get(runId);
    if (entry === undefined) return false;
    entry.cancelledByUser = true;
    entry.controller.abort();
    return true;
  };

  public readonly discover = (projectId: string): EditorVerificationCatalogDiscovery => {
    const resolved = this.resolveWorkspace(projectId);
    const { workspace } = resolved;
    const catalog = detectScripts(workspace, resolved.access.fs);
    const trusted = this.trustedForScripts(resolved);
    const runnable = isRunnableTestFramework(workspace);
    return {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId,
      kinds: CATALOG_KINDS.map((kind) => catalogEntry(kind, catalog.mapping, trusted, runnable)),
    };
  };

  public readonly execute = (input: VerificationRunInput): VerificationRunStart => {
    const { resolved, plan } = this.prepare(input);
    const runId = randomUUID();
    const controller = new AbortController();
    this.runs.set(runId, {
      controller,
      correlationId: input.correlationId ?? runId,
      cancelledByUser: false,
      terminalEmitted: false,
    });
    const run: EditorVerificationRun = {
      runId,
      projectId: input.projectId,
      kinds: [...input.kinds],
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      state: "running",
      startedAtMs: this.now(),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    };
    void this.runPlan(run, resolved, plan);
    return { runId, run };
  };

  // Issue #2214/#2215 fix-up — an agent-triggered run is registered in and accounted against the SAME
  // `this.runs` registry as a human-triggered one (shared concurrency fairness, already true before
  // this fix), and now ALSO emits the identical lifecycle events `execute`/`runPlan` emit for every
  // subscriber (the status bar, the problems panel, and any other human-facing SSE client). This makes
  // an in-flight agent run observable and its `runId` cancellable via the existing
  // `DELETE /runs/:runId` endpoint (which already operates on this same registry) — closing the
  // "invisible, uncancellable" gap without introducing a second execution or registry pipeline.
  public readonly runToReport = async (
    input: VerificationRunInput,
    signal: AbortSignal,
  ): Promise<VerificationReport> => {
    const { resolved, plan } = this.prepare(input);
    const { workspace } = resolved;
    const runId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const entry: InFlightRun = {
      controller,
      correlationId: input.correlationId ?? runId,
      cancelledByUser: false,
      terminalEmitted: false,
    };
    this.runs.set(runId, entry);
    const startedAtMs = this.now();
    this.emitRunStarted(runId, input, startedAtMs);
    this.emitStepsStarted(runId, plan);
    try {
      const { report } = await this.executePort({
        plan,
        workspace,
        signal: controller.signal,
        correlationId: entry.correlationId,
        fs: resolved.access.fs,
      });
      this.emitStepCompletions(runId, report);
      // Awaited path (the agent's HTTP request awaits this promise): an evidence-write failure is
      // surfaced both as the terminal SSE event AND a thrown error, so the caller receives a real
      // failure instead of a redacted report the ledger has no record of.
      this.persistAndEmitTerminalOrThrow(runId, workspace.root, report, startedAtMs, entry);
      this.recordRunnerCompletion(workspace, entry.correlationId, report);
      return report;
    } catch (error) {
      this.recordRunnerFailure(workspace, entry.correlationId, error);
      if (!(error instanceof VerificationRunnerError && error.code === "EVIDENCE_WRITE_FAILED")) {
        this.settleThrownExecution(runId, startedAtMs, entry, error);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.runs.delete(runId);
    }
  };

  private prepare(input: VerificationRunInput): PreparedVerificationRun {
    let workspace: WorkspaceInfo | undefined;
    try {
      const resolved = this.resolveWorkspace(input.projectId, input.correlationId);
      workspace = resolved.workspace;
      const plan = this.buildPlan(resolved, input);
      this.recordRunnerSelection(workspace, input.correlationId, plan.steps.length);
      this.assertRunnable(plan);
      this.assertWorkspaceTrustAtEffect(resolved, input);
      return { resolved, plan };
    } catch (error) {
      this.recordRunnerFailure(workspace, input.correlationId, error);
      throw error;
    }
  }

  private assertRunnable(plan: VerificationPlan): void {
    if (plan.steps.length === 0) {
      throw new VerificationRunnerError(
        "NO_RUNNABLE_STEPS",
        "No runnable verification step was resolved for the requested kinds.",
      );
    }
    if (this.runs.size >= this.maxConcurrentRuns) {
      throw new VerificationRunnerError(
        "RUN_LIMIT_EXCEEDED",
        "Too many in-flight verification runs.",
      );
    }
  }

  private persistAndEmitTerminalOrThrow(
    runId: string,
    projectId: string,
    report: VerificationReport,
    startedAtMs: number,
    entry: InFlightRun,
  ): void {
    try {
      this.persistEvidence(runId, projectId, report, startedAtMs);
    } catch (evidenceError) {
      this.emitEvidenceWriteFailure(runId, entry);
      throw evidenceError;
    }
    this.emitTerminalOnce(runId, entry, report);
  }

  private buildPlan(
    resolved: ResolvedVerificationWorkspace,
    input: VerificationRunInput,
  ): VerificationPlan {
    const { workspace } = resolved;
    const fs = resolved.access.fs;
    const scriptKinds = input.kinds.filter(isScriptBackedKind);
    this.assertWorkspaceTrustForScriptKinds(resolved, scriptKinds);
    const steps = [
      ...this.scriptSteps(workspace, scriptKinds, fs),
      ...this.targetedSteps(workspace, input, fs),
    ];
    return { workspaceRoot: workspace.root, steps };
  }

  private assertWorkspaceTrustAtEffect(
    resolved: ResolvedVerificationWorkspace,
    input: VerificationRunInput,
  ): void {
    this.assertWorkspaceTrustForScriptKinds(resolved, input.kinds.filter(isScriptBackedKind));
  }

  private assertWorkspaceTrustForScriptKinds(
    resolved: ResolvedVerificationWorkspace,
    scriptKinds: readonly VerificationKind[],
  ): void {
    if (scriptKinds.length === 0 || this.trustedForScripts(resolved)) return;
    throw new VerificationRunnerError(
      "WORKSPACE_TRUST_REQUIRED",
      "Repository package scripts require server-side workspace trust before execution.",
    );
  }

  private scriptSteps(
    workspace: WorkspaceInfo,
    scriptKinds: readonly VerificationKind[],
    fs: WorkspaceFs,
  ): VerificationPlan["steps"] {
    if (scriptKinds.length === 0) return [];
    const catalog = detectScripts(workspace, fs);
    return buildVerificationPlan(workspace, catalog, { only: scriptKinds }, fs).steps;
  }

  private targetedSteps(
    workspace: WorkspaceInfo,
    input: VerificationRunInput,
    fs: WorkspaceFs,
  ): VerificationPlan["steps"] {
    if (!input.kinds.includes("targeted-test") || input.targetPath === undefined) return [];
    return planDirectTargetedTests(workspace, [input.targetPath], fs);
  }

  private async runPlan(
    run: EditorVerificationRun,
    resolved: ResolvedVerificationWorkspace,
    plan: VerificationPlan,
  ): Promise<void> {
    const entry = this.runs.get(run.runId);
    if (entry === undefined) return;
    this.emitRunStarted(run.runId, run, run.startedAtMs);
    this.emitStepsStarted(run.runId, plan);
    await this.executeAndReport(run.runId, resolved, plan, entry, run.startedAtMs);
  }

  // Shared by `execute`/`runPlan` (human path) and `runToReport` (agent path, Issue #2214/#2215
  // fix-up) so both surface the identical run-started event to every SSE subscriber.
  private emitRunStarted(
    runId: string,
    input: Pick<VerificationRunInput, "projectId" | "kinds" | "targetPath" | "requestId">,
    startedAtMs: number,
  ): void {
    this.emit({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-started",
      runId,
      projectId: input.projectId,
      kinds: [...input.kinds],
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      startedAtMs,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
  }

  private emitStepsStarted(runId: string, plan: VerificationPlan): void {
    for (const step of plan.steps) {
      this.emit({
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        kind: "step-started",
        runId,
        stepKind: step.kind,
      });
    }
  }

  private async executeAndReport(
    runId: string,
    resolved: ResolvedVerificationWorkspace,
    plan: VerificationPlan,
    entry: InFlightRun,
    startedAtMs: number,
  ): Promise<void> {
    try {
      const { report } = await this.executePort({
        plan,
        workspace: resolved.workspace,
        signal: entry.controller.signal,
        correlationId: entry.correlationId,
        fs: resolved.access.fs,
      });
      this.emitStepCompletions(runId, report);
      // Fire-and-forget path (nothing awaits runPlan): an evidence-write failure must not become an
      // unhandled rejection, so it is caught and surfaced as the terminal event itself rather than
      // rethrown (mirrors TerminalExecutionManager.persistEntryOrEmitFailure's non-crashing variant).
      try {
        this.persistEvidence(runId, resolved.workspace.root, report, startedAtMs);
        this.emitTerminalOnce(runId, entry, report);
        this.recordRunnerCompletion(resolved.workspace, entry.correlationId, report);
      } catch (error) {
        this.recordRunnerFailure(resolved.workspace, entry.correlationId, error);
        this.emitEvidenceWriteFailure(runId, entry);
      }
    } catch (error) {
      this.recordRunnerFailure(resolved.workspace, entry.correlationId, error);
      this.settleThrownExecution(runId, startedAtMs, entry, error);
    } finally {
      this.runs.delete(runId);
    }
  }

  private recordRunnerSelection(
    workspace: WorkspaceInfo,
    correlationId: string | undefined,
    stepCount: number,
  ): void {
    this.activityLog.write({
      category: "process",
      op: "editor.verification.execute",
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      extra: { state: "selected", runnerId: workspace.testFramework, stepCount },
    });
  }

  private recordRunnerCompletion(
    workspace: WorkspaceInfo,
    correlationId: string,
    report: VerificationReport,
  ): void {
    this.activityLog.write({
      category: "process",
      op: "editor.verification.execute",
      correlationId,
      extra: {
        state: "completed",
        runnerId: workspace.testFramework,
        verificationStatus: report.overallStatus,
        stepCount: report.results.length,
        deniedCount: report.counts.denied,
        failedCount: report.counts.failed,
      },
    });
  }

  private recordRunnerFailure(
    workspace: WorkspaceInfo | undefined,
    correlationId: string | undefined,
    error: unknown,
  ): void {
    const detail = describeError(error);
    const reason = error instanceof VerificationRunnerError ? error.code : "INTERNAL";
    this.activityLog.write({
      level: "warn",
      category: "process",
      op: "editor.verification.execute",
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      errorKind: reason,
      extra: {
        state: "refused",
        runnerId: workspace?.testFramework ?? "unknown",
        reason,
        ...(detail.frames === undefined ? {} : { frames: detail.frames }),
        ...(detail.causeChain === undefined ? {} : { causeChain: detail.causeChain }),
      },
    });
  }

  private emitStepCompletions(runId: string, report: VerificationReport): void {
    for (const result of report.results) {
      this.emit({
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        kind: "step-completed",
        runId,
        stepKind: result.kind,
        status: result.status,
        durationMs: result.durationMs,
      });
    }
  }

  // A cancelled run wins over a failure; a missing report (thrown) becomes a content-free run-failed
  // (a static reason code, never the raw error message which may carry a path).
  private emitTerminalOnce(
    runId: string,
    entry: InFlightRun,
    report: VerificationReport | undefined,
  ): void {
    if (entry.terminalEmitted) return;
    entry.terminalEmitted = true;
    this.emitTerminal(runId, entry.cancelledByUser || entry.controller.signal.aborted, report);
  }

  private emitTerminal(
    runId: string,
    cancelled: boolean,
    report: VerificationReport | undefined,
  ): void {
    if (cancelled) {
      this.emit({
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        kind: "run-cancelled",
        runId,
      });
      return;
    }
    if (report === undefined) {
      this.emit({
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        kind: "run-failed",
        runId,
        reason: "verification-run-execution-failed",
      });
      return;
    }
    this.emit({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-completed",
      runId,
      report,
    });
  }

  private settleThrownExecution(
    runId: string,
    startedAt: number,
    entry: InFlightRun,
    error: unknown,
  ): void {
    const finishedAt = this.now();
    const cancelled = entry.cancelledByUser || entry.controller.signal.aborted;
    if (!cancelled) this.recordUnexpectedExecution(entry.correlationId, error, finishedAt);
    try {
      this.persistInterruptedEvidence(runId, startedAt, finishedAt, cancelled);
    } catch {
      this.emitEvidenceWriteFailure(runId, entry);
      return;
    }
    this.emitTerminalOnce(runId, entry, undefined);
  }

  private recordUnexpectedExecution(
    correlationId: string,
    error: unknown,
    timestampMs: number,
  ): void {
    emitServerDiagnostic(this.diagnostics, {
      correlationId,
      timestamp: new Date(timestampMs).toISOString(),
      operation: "editor.verification.execute",
      source: "editor.verification-runner",
      errorClass: error instanceof Error ? "Error" : "NonErrorThrow",
      message: "Verification execution failed unexpectedly.",
    });
  }

  // Issue #2211 fix-up (Epic #2092): writes the content-free audit-evidence entry for a finished
  // run, mirroring CommandRunnerManagerImpl.persist(). Fails closed — a governed execution surface
  // must not run silently unaudited (AGENTS.md "no silent failures").
  private persistEvidence(
    runId: string,
    projectId: string,
    report: VerificationReport,
    startedAt: number,
  ): void {
    if (this.evidenceStore === undefined) {
      throw new VerificationRunnerError(
        "EVIDENCE_WRITE_FAILED",
        "Verification run evidence store is unavailable.",
      );
    }
    try {
      const entry = buildEditorVerificationRunEvidenceEntry({
        runId,
        projectId,
        report,
        startedAt,
      });
      appendEditorVerificationRunEvidence(
        this.evidenceStore,
        entry,
        this.redactor,
        DEFAULT_RETENTION,
        evidenceRetentionDiagnosticObserver(this.diagnostics, "editor-verification-run"),
      );
    } catch {
      throw new VerificationRunnerError(
        "EVIDENCE_WRITE_FAILED",
        "Verification run evidence could not be persisted.",
      );
    }
  }

  private persistInterruptedEvidence(
    runId: string,
    startedAt: number,
    finishedAt: number,
    cancelled: boolean,
  ): void {
    if (this.evidenceStore === undefined) {
      throw new VerificationRunnerError(
        "EVIDENCE_WRITE_FAILED",
        "Verification run evidence store is unavailable.",
      );
    }
    const evidence = buildEditorVerificationInterruptedEvidenceEntry({
      runId,
      startedAt,
      finishedAt,
      cancelled,
    });
    try {
      appendEditorVerificationRunEvidence(
        this.evidenceStore,
        evidence,
        this.redactor,
        DEFAULT_RETENTION,
        evidenceRetentionDiagnosticObserver(this.diagnostics, "editor-verification-run"),
      );
    } catch {
      throw new VerificationRunnerError(
        "EVIDENCE_WRITE_FAILED",
        "Verification run evidence could not be persisted.",
      );
    }
  }

  private emitEvidenceWriteFailure(runId: string, entry: InFlightRun): void {
    if (entry.terminalEmitted) return;
    entry.terminalEmitted = true;
    this.emit({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-failed",
      runId,
      reason: "verification-evidence-write-failed",
    });
  }

  private trustedForScripts(resolved: ResolvedVerificationWorkspace): boolean {
    try {
      return (
        this.trustBasisMatchesNow(resolved) &&
        this.isTrusted(resolved.trustProjectId, resolved.trustWorkspace)
      );
    } catch {
      return false;
    }
  }

  // Re-derived from the filesystem on EVERY ask — plan time, at-effect, and catalog projection —
  // never cached on the resolved workspace. See `ResolvedVerificationWorkspace.trustBasisRepositoryRoot`.
  private trustBasisMatchesNow(resolved: ResolvedVerificationWorkspace): boolean {
    const repositoryRoot = resolved.trustBasisRepositoryRoot;
    // An ORDINARY root is its own trust basis and has nothing to compare against — and it is now the
    // only kind that reaches this branch, because `WorkspaceRootAccess`'s `managed-task` member
    // REQUIRES `repositoryRoot`. The previous fail-closed answer for "a managed access naming no
    // repository" (CodeRabbit, PR #3381) guarded a configuration the type no longer admits.
    if (repositoryRoot === undefined) return true;
    return worktreeSharesRepositoryTrustBasis(resolved.access, repositoryRoot, this.fs);
  }

  private resolveWorkspace(
    projectId: string,
    correlationId?: string,
  ): ResolvedVerificationWorkspace {
    const project = projectFor(this.store, projectId);
    // A managed task worktree's package-script decision is never taken from its OWN row. Production
    // does register the worktree as a project (deps.ts `ensureManagedTaskWorkspaceIdentity` calls
    // `createProject(managedWorktreePath)` on provision/activate), so `project` is usually defined
    // here and `accessFor` returns the managed grant; the branch below covers the case where no row
    // resolves for the requested root. Either way the root access resolver is what proves the root
    // (lifecycle row, identity, containment) and names the repository whose script trust governs
    // it, valid only while the worktree manifest is that same trust-basis fact (ADR-0147 D3).
    // Before this, script trust was looked up for the worktree's own unregistered root and every
    // governed verification inside a task workspace was refused (workbench end-to-end run,
    // 2026-09-03). An unregistered ORDINARY root still fails closed here.
    const access =
      project === undefined
        ? this.managedAccessFor(projectId, correlationId)
        : this.accessFor(project.path, correlationId);
    if (access === undefined) {
      throw new VerificationRunnerError(
        "PROJECT_NOT_FOUND",
        project === undefined ? "Project not found." : "Project root path could not be resolved.",
      );
    }
    const workspace = detectWorkspaceAt(access.canonicalRoot, access.fs);
    const repositoryRoot = access.kind === "managed-task" ? access.repositoryRoot : undefined;
    if (repositoryRoot === undefined) {
      return {
        access,
        workspace,
        trustProjectId: projectId,
        trustWorkspace: workspace,
        // An ordinary root is its own basis, so there is nothing to compare against.
        trustBasisRepositoryRoot: undefined,
      };
    }
    return {
      access,
      workspace,
      trustProjectId: repositoryRoot,
      trustWorkspace: detectWorkspaceAt(repositoryRoot, this.fs, {
        scanSourceFilesForLanguages: false,
      }),
      trustBasisRepositoryRoot: repositoryRoot,
    };
  }

  private accessFor(
    projectPath: string,
    correlationId: string | undefined,
  ): WorkspaceRootAccess | undefined {
    try {
      return (
        this.rootAccessResolver?.(projectPath, correlationId) ??
        (this.rootAccessResolver === undefined
          ? { kind: "ordinary", canonicalRoot: this.fs.realPath(projectPath), fs: this.fs }
          : undefined)
      );
    } catch {
      return undefined;
    }
  }

  private managedAccessFor(
    root: string,
    correlationId: string | undefined,
  ): WorkspaceRootAccess | undefined {
    try {
      const access = this.rootAccessResolver?.(root, correlationId);
      return access?.kind === "managed-task" ? access : undefined;
    } catch {
      return undefined;
    }
  }

  private emit(event: EditorVerificationEvent): void {
    [...this.subscribers].forEach((listener) => {
      try {
        listener(event);
      } catch {
        this.recordSubscriberFailure(event.runId);
      }
    });
  }

  private recordSubscriberFailure(runId: string): void {
    emitServerDiagnostic(this.diagnostics, {
      correlationId: this.runs.get(runId)?.correlationId ?? runId,
      timestamp: new Date(this.now()).toISOString(),
      operation: "editor.verification.subscriber",
      source: "editor.verification-runner",
      errorClass: "VerificationSubscriber",
      message: "A verification event subscriber failed.",
    });
  }
}

/**
 * The package-script grant is bound to the granted root's exact `package.json` bytes (ADR-0147 D3),
 * so a managed task worktree may only run scripts under its repository's grant while its own
 * manifest is that same fact. A governed run can edit `package.json` inside its worktree; without
 * this the runner would answer "trusted" from the repository's record and spawn the rewritten
 * script with no human decision (P1, PR #3381 review). Fails closed on any unreadable manifest.
 *
 * Exported so the agent verification route (`agentVerificationRoute.ts`), which composes its own
 * policy decision from the same standing grant before this runner is reached, asks THIS rule
 * instead of restating it — one definition of "may this worktree run its repository's scripts".
 */
export function worktreeSharesRepositoryTrustBasis(
  access: WorkspaceRootAccess,
  repositoryRoot: string,
  repositoryFs: WorkspaceFs,
): boolean {
  try {
    return trustBasisFactsMatch(
      resolveTrustBasisFact(access.fs, access.canonicalRoot),
      resolveTrustBasisFact(repositoryFs, repositoryRoot),
    );
  } catch {
    return false;
  }
}

function isRunnableTestFramework(workspace: WorkspaceInfo): boolean {
  return (
    workspace.testFramework === "vitest" ||
    workspace.testFramework === "jest" ||
    workspace.testFramework === "node-test"
  );
}

function catalogEntry(
  kind: VerificationKind,
  mapping: ReturnType<typeof detectScripts>["mapping"],
  trusted: boolean,
  runnableTestFramework: boolean,
): EditorVerificationCatalogEntry {
  if (kind === "targeted-test") {
    // Keiko-synthesized invocation; exempt from workspace trust (parity with post-apply verification).
    return { kind, available: runnableTestFramework, trustState: "trusted" };
  }
  const trustState: EditorVerificationTrustState = trusted ? "trusted" : "approval-required";
  return { kind, available: mapping[kind] !== undefined, trustState };
}

export function createVerificationRunnerManager(
  opts: VerificationRunnerManagerOptions,
): VerificationRunnerManager {
  return new VerificationRunnerManagerImpl(opts);
}
