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
import {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  type EditorVerificationCatalog,
  type EditorVerificationCatalogEntry,
  type EditorVerificationEvent,
  type EditorVerificationRun,
  type EditorVerificationTrustState,
  type VerificationKind,
  type VerificationPlan,
  type VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
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
import {
  appendEditorVerificationRunEvidence,
  buildEditorVerificationRunEvidenceEntry,
} from "./verification-run-evidence.js";
import {
  executeVerificationEnforced,
  type ExecuteVerificationArgs,
  type ExecuteVerificationResult,
} from "./verificationExecution.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import type { Project, UiStore } from "../store/index.js";

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
}

export interface VerificationRunStart {
  readonly runId: string;
  readonly run: EditorVerificationRun;
}

export type VerificationRunnerEventEmitter = (event: EditorVerificationEvent) => void;
export type VerificationRunnerWorkspaceTrustDecider = (workspace: WorkspaceInfo) => boolean;
export type VerificationExecutePort = (
  args: ExecuteVerificationArgs,
) => Promise<ExecuteVerificationResult>;

export interface VerificationRunnerManager {
  readonly discover: (projectId: string) => EditorVerificationCatalog;
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
}

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
  cancelledByUser: boolean;
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

  public readonly discover = (projectId: string): EditorVerificationCatalog => {
    const workspace = this.resolveWorkspace(projectId);
    const catalog = detectScripts(workspace, this.fs);
    const trusted = this.trustedForScripts(workspace);
    const runnable = isRunnableTestFramework(workspace);
    return {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId,
      kinds: CATALOG_KINDS.map((kind) => catalogEntry(kind, catalog.mapping, trusted, runnable)),
    };
  };

  public readonly execute = (input: VerificationRunInput): VerificationRunStart => {
    const workspace = this.resolveWorkspace(input.projectId);
    const plan = this.buildPlan(workspace, input);
    this.assertRunnable(plan);
    const runId = randomUUID();
    const controller = new AbortController();
    this.runs.set(runId, { controller, cancelledByUser: false });
    const run: EditorVerificationRun = {
      runId,
      projectId: input.projectId,
      kinds: [...input.kinds],
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      state: "running",
      startedAtMs: this.now(),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    };
    void this.runPlan(run, workspace, plan);
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
    const workspace = this.resolveWorkspace(input.projectId);
    const plan = this.buildPlan(workspace, input);
    this.assertRunnable(plan);
    const runId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const entry: InFlightRun = { controller, cancelledByUser: false };
    this.runs.set(runId, entry);
    const startedAtMs = this.now();
    this.emitRunStarted(runId, input, startedAtMs);
    this.emitStepsStarted(runId, plan);
    try {
      const { report } = await this.executePort({ plan, workspace, signal: controller.signal });
      this.emitStepCompletions(runId, report);
      // Awaited path (the agent's HTTP request awaits this promise): an evidence-write failure is
      // surfaced both as the terminal SSE event AND a thrown error, so the caller receives a real
      // failure instead of a redacted report the ledger has no record of.
      this.persistAndEmitTerminalOrThrow(runId, workspace.root, report, startedAtMs, entry);
      return report;
    } catch (error) {
      if (!(error instanceof VerificationRunnerError && error.code === "EVIDENCE_WRITE_FAILED")) {
        this.emitTerminal(runId, entry.cancelledByUser, undefined);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.runs.delete(runId);
    }
  };

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
      this.emitEvidenceWriteFailure(runId);
      throw evidenceError;
    }
    this.emitTerminal(runId, entry.cancelledByUser, report);
  }

  private buildPlan(workspace: WorkspaceInfo, input: VerificationRunInput): VerificationPlan {
    const scriptKinds = input.kinds.filter(isScriptBackedKind);
    if (scriptKinds.length > 0 && !this.trustedForScripts(workspace)) {
      throw new VerificationRunnerError(
        "WORKSPACE_TRUST_REQUIRED",
        "Repository package scripts require server-side workspace trust before execution.",
      );
    }
    const steps = [
      ...this.scriptSteps(workspace, scriptKinds),
      ...this.targetedSteps(workspace, input),
    ];
    return { workspaceRoot: workspace.root, steps };
  }

  private scriptSteps(
    workspace: WorkspaceInfo,
    scriptKinds: readonly VerificationKind[],
  ): VerificationPlan["steps"] {
    if (scriptKinds.length === 0) return [];
    const catalog = detectScripts(workspace, this.fs);
    return buildVerificationPlan(workspace, catalog, { only: scriptKinds }, this.fs).steps;
  }

  private targetedSteps(
    workspace: WorkspaceInfo,
    input: VerificationRunInput,
  ): VerificationPlan["steps"] {
    if (!input.kinds.includes("targeted-test") || input.targetPath === undefined) return [];
    return planDirectTargetedTests(workspace, [input.targetPath], this.fs);
  }

  private async runPlan(
    run: EditorVerificationRun,
    workspace: WorkspaceInfo,
    plan: VerificationPlan,
  ): Promise<void> {
    const entry = this.runs.get(run.runId);
    if (entry === undefined) return;
    this.emitRunStarted(run.runId, run, run.startedAtMs);
    this.emitStepsStarted(run.runId, plan);
    await this.executeAndReport(run.runId, workspace, plan, entry, run.startedAtMs);
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
    workspace: WorkspaceInfo,
    plan: VerificationPlan,
    entry: InFlightRun,
    startedAtMs: number,
  ): Promise<void> {
    try {
      const { report } = await this.executePort({
        plan,
        workspace,
        signal: entry.controller.signal,
      });
      this.emitStepCompletions(runId, report);
      // Fire-and-forget path (nothing awaits runPlan): an evidence-write failure must not become an
      // unhandled rejection, so it is caught and surfaced as the terminal event itself rather than
      // rethrown (mirrors TerminalExecutionManager.persistEntryOrEmitFailure's non-crashing variant).
      try {
        this.persistEvidence(runId, workspace.root, report, startedAtMs);
        this.emitTerminal(runId, entry.cancelledByUser, report);
      } catch {
        this.emitEvidenceWriteFailure(runId);
      }
    } catch {
      this.emitTerminal(runId, entry.cancelledByUser, undefined);
    } finally {
      this.runs.delete(runId);
    }
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
      appendEditorVerificationRunEvidence(this.evidenceStore, entry, this.redactor);
    } catch {
      throw new VerificationRunnerError(
        "EVIDENCE_WRITE_FAILED",
        "Verification run evidence could not be persisted.",
      );
    }
  }

  private emitEvidenceWriteFailure(runId: string): void {
    this.emit({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-failed",
      runId,
      reason: "verification-evidence-write-failed",
    });
  }

  private trustedForScripts(workspace: WorkspaceInfo): boolean {
    try {
      return this.isTrusted(workspace);
    } catch {
      return false;
    }
  }

  private resolveWorkspace(projectId: string): WorkspaceInfo {
    const project = projectFor(this.store, projectId);
    if (project === undefined) {
      throw new VerificationRunnerError("PROJECT_NOT_FOUND", "Project not found.");
    }
    let realRoot: string;
    try {
      realRoot = this.fs.realPath(project.path);
    } catch {
      throw new VerificationRunnerError(
        "PROJECT_NOT_FOUND",
        "Project root path could not be resolved.",
      );
    }
    return detectWorkspaceAt(realRoot, this.fs);
  }

  private emit(event: EditorVerificationEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not stop fan-out (matches the command-runner/terminal pattern).
      }
    }
  }
}

function isRunnableTestFramework(workspace: WorkspaceInfo): boolean {
  return workspace.testFramework === "vitest" || workspace.testFramework === "jest";
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
