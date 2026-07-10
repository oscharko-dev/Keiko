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
  private readonly runs = new Map<string, InFlightRun>();
  private readonly subscribers = new Set<VerificationRunnerEventEmitter>();

  public constructor(opts: VerificationRunnerManagerOptions) {
    this.store = opts.store;
    this.fs = opts.fs ?? nodeWorkspaceFs;
    this.isTrusted = opts.isWorkspaceTrustedForPackageScripts ?? ((): boolean => false);
    this.now = opts.now ?? Date.now;
    this.executePort = opts.execute ?? executeVerificationEnforced;
    this.maxConcurrentRuns = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
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
    const runId = randomUUID();
    const controller = new AbortController();
    this.runs.set(runId, { controller, cancelledByUser: false });
    const run: EditorVerificationRun = {
      runId,
      kinds: [...input.kinds],
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      state: "running",
      startedAtMs: this.now(),
    };
    void this.runPlan(run, workspace, plan);
    return { runId, run };
  };

  public readonly runToReport = async (
    input: VerificationRunInput,
    signal: AbortSignal,
  ): Promise<VerificationReport> => {
    const workspace = this.resolveWorkspace(input.projectId);
    const plan = this.buildPlan(workspace, input);
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
    const runId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    this.runs.set(runId, { controller, cancelledByUser: false });
    try {
      const { report } = await this.executePort({ plan, workspace, signal: controller.signal });
      return report;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.runs.delete(runId);
    }
  };

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
    this.emit({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-started",
      runId: run.runId,
      kinds: run.kinds,
      ...(run.targetPath === undefined ? {} : { targetPath: run.targetPath }),
      startedAtMs: run.startedAtMs,
    });
    for (const step of plan.steps) {
      this.emit({
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        kind: "step-started",
        runId: run.runId,
        stepKind: step.kind,
      });
    }
    await this.executeAndReport(run.runId, workspace, plan, entry);
  }

  private async executeAndReport(
    runId: string,
    workspace: WorkspaceInfo,
    plan: VerificationPlan,
    entry: InFlightRun,
  ): Promise<void> {
    try {
      const { report } = await this.executePort({
        plan,
        workspace,
        signal: entry.controller.signal,
      });
      this.emitStepCompletions(runId, report);
      this.emitTerminal(runId, entry.cancelledByUser, report);
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
