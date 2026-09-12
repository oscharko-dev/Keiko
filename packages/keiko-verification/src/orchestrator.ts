// The verification orchestrator (ADR-0007 D2–D5). Runs each plan step sequentially through the
// UNCHANGED #6 runCommand, applying per-command resource limits, honest appliedLimits, memory
// monitoring via a SpawnFn wrapper + ResourceMonitor seam (never modifying src/tools), cross-step
// cancellation, and a redacted output digest. Error handling lives only at this IO boundary; the
// classification it feeds is pure.

import { redact } from "@oscharko-dev/keiko-security";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
import {
  VERIFICATION_DEPENDENCY_FAILURE_STATES,
  type VerificationDependencySummary,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import {
  DEFAULT_COMMAND_RULES,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandRule,
  type CommandResult,
  type NetworkPolicy,
  type RunCommandDeps,
  type SandboxPolicy,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { classifyOutcome, type AbortReason } from "./classify.js";
import {
  planDependencyBootstrap,
  runDependencyBootstrap,
  type DependencyBootstrapDeps,
  type DependencyBootstrapOutcome,
} from "./dependencies.js";
import { classifyScripts } from "./detect.js";
import { outputExcerpt } from "./excerpt.js";
import { extractFailureLocations } from "./failure-location.js";
import { buildAppliedLimits, type BreachedDimension } from "./limits.js";
import { nodeResourceMonitor, type ResourceMonitor } from "./monitor.js";
import type {
  VerificationKind,
  VerificationPlan,
  VerificationReport,
  VerificationResourceLimits,
  VerificationResult,
  VerificationStatus,
  VerificationStep,
} from "./types.js";

// How the orchestrator treats a step that declares `limits.network === "none"` (ADR-0043).
//   - "inherit"               — explicit compatibility escape hatch: never enforce egress; every step
//                               runs with network:"inherit".
//   - "enforce-or-degrade"    — request an enforced network:"none" run when an enforcing sandbox backend
//                               is available; otherwise fall back to network:"inherit" and report it
//                               honestly (appliedLimits network `enforced: false`). A strict improvement
//                               that never breaks a backend-less host.
//   - "enforce-or-fail-closed"— request an enforced network:"none" run when a backend is available;
//                               otherwise DENY the step before spawning (Issue #1204): untrusted,
//                               model-generated code is never executed without an enforced egress
//                               boundary.
export type NetworkEnforcementMode = "inherit" | "enforce-or-degrade" | "enforce-or-fail-closed";

export interface VerificationDeps {
  readonly workspace: WorkspaceInfo;
  readonly signal?: AbortSignal | undefined;
  // Base SpawnFn the orchestrator wraps with the memory monitor; defaults to the #6 node spawn.
  readonly spawn?: SpawnFn | undefined;
  readonly monitor?: ResourceMonitor | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly fs?: WorkspaceFs | undefined;
  readonly resolveExecutable?: RunCommandDeps["resolveExecutable"] | undefined;
  readonly sandboxAvailability?: RunCommandDeps["sandboxAvailability"] | undefined;
  readonly platform?: RunCommandDeps["platform"] | undefined;
  // Egress-enforcement policy for `network:"none"` steps. Default is "enforce-or-fail-closed": a
  // no-network verification step does not execute unless the caller attests an enforcing backend.
  readonly networkEnforcement?: NetworkEnforcementMode | undefined;
  // Whether an enforcing sandbox backend is available on this host for a network:"none" run. The caller
  // probes keiko-sandbox once (a synchronous PATH/binary check) and injects the result, so the
  // orchestrator stays free of a keiko-sandbox dependency and tests stay deterministic. Default false.
  readonly enforcedNetworkAvailable?: boolean | undefined;
  // Termination-evidence port for every verification step (RunCommandDeps deps-level seam,
  // keiko-tools exec.ts): wired once by the composing server so a timed-out or aborted step's
  // Windows tree-kill disposition is reconstructable (PR #3354 review, comment 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
  // ADR-0043 D17: "auto" installs the manifest's declared dependencies before the first script step
  // when the installed tree is not current (dependencies.ts). Default "off" keeps every SDK caller's
  // behaviour unchanged; the server's verification runner turns it on.
  readonly dependencyBootstrap?: "off" | "auto" | undefined;
  // The bounded, redacted output of a step that did not pass (and of a failed dependency
  // bootstrap), handed over as it happens and never written into the report: the report is
  // persisted as body-free evidence, while the caller may forward the excerpt to the actor that
  // has to repair the failure (the coding model, ADR-0126 D3).
  readonly onStepOutput?: ((output: VerificationStepOutput) => void) | undefined;
}

export interface VerificationStepOutput {
  readonly step: VerificationKind | "dependencies";
  readonly scriptName: string | undefined;
  readonly excerpt: string;
}

// Verification runs deterministic repository gates selected by Keiko, not arbitrary model-issued
// run_command calls. Keep the model-facing defaults read-only while allowing the verification
// orchestrator to invoke npm scripts and framework-targeted npx runs through the same #6 boundary.
export const VERIFICATION_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "npm",
    allowedSubcommands: Object.freeze(["test", "run"]),
    denyFlags: Object.freeze(["-c", "--call"]),
  },
  {
    executable: "npx",
    allowedSubcommands: Object.freeze(["vitest", "jest"]),
    denyFlags: Object.freeze(["-c", "--call"]),
  },
  {
    executable: "node",
    requiredLeadingFlags: Object.freeze(["--test"]),
    denyFlags: Object.freeze(["-e", "--eval", "-p", "--print", "-r", "--require", "--import"]),
  },
  ...DEFAULT_COMMAND_RULES,
]);

const ALL_STATUSES: readonly VerificationStatus[] = [
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
];

// Maps a step's resource limits and the run's resolved network policy onto a #6 SandboxPolicy:
// wall-time and output-size are enforced by runCommand. Memory is NOT a SandboxPolicy field — it is
// handled by the SpawnFn-wrapper monitor, so it does not appear here. The network policy is resolved by
// `resolveStepNetwork` from the run's enforcement mode and probed backend availability (ADR-0043); for
// an enforced "none" run, runCommand wraps the spawn through keiko-sandbox and records the attestation,
// which `buildAppliedLimits` reports honestly.
function policyForStep(limits: VerificationResourceLimits, network: NetworkPolicy): SandboxPolicy {
  return {
    ...DEFAULT_SANDBOX_POLICY,
    maxOutputBytes: limits.maxOutputBytes,
    defaultTimeoutMs: limits.wallTimeMs,
    network,
  };
}

// The per-step network decision: either run with a concrete policy, or fail closed before spawning.
type NetworkResolution =
  { readonly kind: "run"; readonly network: NetworkPolicy } | { readonly kind: "fail-closed" };

// Pure resolution of a step's effective network policy from the run's enforcement mode and whether an
// enforcing backend is available. An explicit compatibility mode ("inherit") and any step that does
// not declare `network:"none"` run with inherited network. Enforce modes on a `network:"none"` step
// request enforcement; when no backend is available they degrade honestly or fail closed per the mode.
export function resolveStepNetwork(
  limits: VerificationResourceLimits,
  mode: NetworkEnforcementMode,
  available: boolean,
): NetworkResolution {
  if (mode === "inherit") {
    return { kind: "run", network: "inherit" };
  }
  if (limits.network !== "none") {
    return { kind: "run", network: limits.network };
  }
  if (available) {
    return { kind: "run", network: "none" };
  }
  return mode === "enforce-or-degrade"
    ? { kind: "run", network: "inherit" }
    : { kind: "fail-closed" };
}

// Data-minimal output metadata. #6 already redacts/caps each stream, but regulated CLI/SDK
// summaries should not echo arbitrary repository logs or customer data by default.
function outputDigest(result: CommandResult | undefined): string {
  if (result === undefined) {
    return "";
  }
  const combined = `${result.stdout}${result.stderr}`;
  if (combined.length === 0) {
    return "";
  }
  if (result.truncated) {
    return "command output exceeded the configured output-size limit and was omitted";
  }
  const bytes = Buffer.byteLength(combined, "utf8");
  return `command output captured (${String(bytes)} bytes) and omitted from summary`;
}

// Derives which single dimension tripped, so exactly one appliedLimits row is breached:true.
function breachedDimension(
  status: VerificationStatus,
  abortReason: AbortReason,
  result: CommandResult | undefined,
): BreachedDimension {
  if (abortReason === "memory") {
    return "memory";
  }
  if (status === "timed-out") {
    return "wall-time";
  }
  if (status === "resource-exceeded" && result?.truncated === true) {
    return "output-size";
  }
  return undefined;
}

interface StepRun {
  readonly result: CommandResult | undefined;
  readonly error: unknown;
  readonly abortReason: AbortReason;
  readonly durationMs: number;
}

function deniedResult(
  step: VerificationStep,
  reason: string,
  processTreeMemoryEnforced?: boolean,
): VerificationResult {
  return {
    kind: step.kind,
    scriptName: step.scriptName,
    command: step.command,
    args: step.args,
    status: "denied",
    exitCode: null,
    signal: null,
    durationMs: 0,
    truncated: false,
    redacted: true,
    outputSummary: "",
    appliedLimits: buildAppliedLimits(
      step.limits,
      undefined,
      false,
      processTreeMemoryEnforced ?? false,
    ),
    detail: redact(reason),
  };
}

function isGeneratedSkipShape(step: VerificationStep): boolean {
  return (
    step.kind !== "targeted-test" &&
    step.skipReason !== undefined &&
    step.scriptName === undefined &&
    step.command === "npm" &&
    step.args.length === 2 &&
    step.args[0] === "run" &&
    step.args[1] === step.kind
  );
}

function hasWindowsDrivePrefix(value: string): boolean {
  return value.length >= 2 && value[1] === ":";
}

function isGeneratedTargetPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    hasWindowsDrivePrefix(value)
  ) {
    return false;
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function scriptNameMatchesKind(step: VerificationStep): boolean {
  if (step.kind === "targeted-test" || step.scriptName === undefined) {
    return false;
  }
  return classifyScripts({ [step.scriptName]: "" })[step.kind] === step.scriptName;
}

function isValidTargetedStep(step: VerificationStep): boolean {
  if (step.scriptName !== undefined || step.args.length < 2) {
    return false;
  }
  if (step.command === "node") {
    return step.args[0] === "--test" && step.args.slice(1).every(isGeneratedTargetPath);
  }
  if (step.command !== "npx") return false;
  return isValidNpxTargetedArgs(step.args);
}

function isValidNpxTargetedArgs(args: readonly string[]): boolean {
  if (args[0] === "vitest") {
    return args[1] === "run" && args.length >= 3 && args.slice(2).every(isGeneratedTargetPath);
  }
  if (args[0] === "jest") {
    return args.length >= 2 && args.slice(1).every(isGeneratedTargetPath);
  }
  return false;
}

function isValidTestStep(step: VerificationStep): boolean {
  if (step.kind === "test") {
    if (step.scriptName === "test") {
      return step.args.length === 1 && step.args[0] === "test";
    }
    return (
      scriptNameMatchesKind(step) &&
      step.args.length === 2 &&
      step.args[0] === "run" &&
      step.args[1] === step.scriptName
    );
  }
  return false;
}

function isValidScriptStep(step: VerificationStep): boolean {
  if (step.command !== "npm") {
    return false;
  }
  if (step.kind === "test") {
    return isValidTestStep(step);
  }
  if (!scriptNameMatchesKind(step)) {
    return false;
  }
  return step.args.length === 2 && step.args[0] === "run" && step.args[1] === step.scriptName;
}

function isValidVerificationStep(step: VerificationStep): boolean {
  if (isGeneratedSkipShape(step)) {
    return true;
  }
  return step.kind === "targeted-test" ? isValidTargetedStep(step) : isValidScriptStep(step);
}

// Runs one command step through #6, wrapping the base SpawnFn with the memory monitor and owning
// the AbortController. The monitor's unwatch runs in `finally` on EVERY settle path (resolve,
// reject, denied-before-spawn where stop is never set, or a throwing await), so the sampling
// interval can never leak (ADR-0007 D3).
async function runStep(
  step: VerificationStep,
  deps: VerificationDeps,
  baseSpawn: SpawnFn,
  monitor: ResourceMonitor,
  network: NetworkPolicy,
): Promise<StepRun> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let abortReason: AbortReason;
  const ac = new AbortController();
  const onHarnessAbort = (): void => {
    abortReason ??= "harness";
    ac.abort();
  };
  deps.signal?.addEventListener("abort", onHarnessAbort, { once: true });
  let stop: (() => void) | undefined;
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = baseSpawn(cmd, args, opts);
    stop = monitor.watch(child.pid, step.limits.maxMemoryBytes, () => {
      abortReason ??= "memory";
      ac.abort();
    });
    return child;
  };
  try {
    const result = await runCommand(
      {
        command: step.command,
        args: step.args,
        cwd: undefined,
        timeoutMs: step.limits.wallTimeMs,
        signal: ac.signal,
      },
      buildRunDeps(deps, step, spawn, network),
    );
    return { result, error: undefined, abortReason, durationMs: result.durationMs };
  } catch (error) {
    return { result: undefined, error, abortReason, durationMs: now() - startedAt };
  } finally {
    stop?.();
    deps.signal?.removeEventListener("abort", onHarnessAbort);
  }
}

function buildRunDeps(
  deps: VerificationDeps,
  step: VerificationStep,
  spawn: SpawnFn,
  network: NetworkPolicy,
): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: policyForStep(step.limits, network),
    commandRules: VERIFICATION_COMMAND_RULES,
    spawn,
    processEnv: deps.processEnv ?? process.env,
    now: deps.now ?? Date.now,
    fs: deps.fs ?? nodeWorkspaceFs,
    ...(deps.resolveExecutable === undefined ? {} : { resolveExecutable: deps.resolveExecutable }),
    ...(deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }),
    ...(deps.sandboxAvailability === undefined
      ? {}
      : { sandboxAvailability: deps.sandboxAvailability }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

function skippedResult(step: VerificationStep): VerificationResult {
  return {
    kind: step.kind,
    scriptName: step.scriptName,
    command: step.command,
    args: step.args,
    status: "skipped",
    exitCode: null,
    signal: null,
    durationMs: 0,
    truncated: false,
    redacted: true,
    outputSummary: "",
    appliedLimits: buildAppliedLimits(step.limits, undefined, false, false),
    detail: redact(step.skipReason ?? "skipped"),
  };
}

function cancelledResult(step: VerificationStep): VerificationResult {
  return {
    kind: step.kind,
    scriptName: step.scriptName,
    command: step.command,
    args: step.args,
    status: "cancelled",
    exitCode: null,
    signal: null,
    durationMs: 0,
    truncated: false,
    redacted: true,
    outputSummary: "",
    appliedLimits: buildAppliedLimits(step.limits, undefined, false, false),
    detail: "cancelled before execution",
  };
}

// Honest network-enforcement reporting (ADR-0043 D4): the attestation is present only when this run
// requested network:"none" and keiko-sandbox wrapped the spawn; an inherited-network run carries no
// attestation, so this is false and the appliedLimits network row stays documented-not-enforced.
function networkEnforcedOf(result: CommandResult | undefined): boolean {
  return result?.attestation?.networkEnforced ?? false;
}

function toResult(
  step: VerificationStep,
  run: StepRun,
  workspaceRoot: string,
  processTreeMemoryEnforced: boolean,
): VerificationResult {
  const status = classifyOutcome({
    skipped: false,
    result: run.result,
    error: run.error,
    abortReason: run.abortReason,
  });
  const breached = breachedDimension(status, run.abortReason, run.result);
  const networkEnforced = networkEnforcedOf(run.result);
  // Issue #2211 (ADR-0126 D3): populate structured failure locations from the already-redacted output
  // before outputDigest discards it. Only attached when non-empty, so a result with no parseable
  // failure keeps its exact prior shape (additive, backward-compatible).
  const locations = extractFailureLocations(step.kind, run.result, workspaceRoot);
  return {
    kind: step.kind,
    scriptName: step.scriptName,
    command: step.command,
    args: step.args,
    status,
    exitCode: run.result?.exitCode ?? null,
    signal: run.result?.signal ?? null,
    durationMs: run.result?.durationMs ?? run.durationMs,
    truncated: run.result?.truncated ?? false,
    redacted: true,
    outputSummary: outputDigest(run.result),
    appliedLimits: buildAppliedLimits(
      step.limits,
      breached,
      networkEnforced,
      processTreeMemoryEnforced,
    ),
    detail: detailFor(status, run),
    ...(locations.length > 0 ? { locations } : {}),
  };
}

function detailFor(status: VerificationStatus, run: StepRun): string | undefined {
  if (run.abortReason === "memory") {
    return "memory ceiling exceeded";
  }
  // For denied/failed paths the rejection message (already a redacted Error from #6 for denied)
  // is re-redacted here as defence in depth before it reaches the report.
  if ((status === "denied" || status === "failed") && run.error instanceof Error) {
    return redact(run.error.message);
  }
  return undefined;
}

function overallStatus(
  results: readonly VerificationResult[],
  cancelled: boolean,
  dependencies: VerificationDependencySummary | undefined,
): VerificationStatus {
  if (cancelled || dependencies?.state === "cancelled") {
    return "cancelled";
  }
  // A bootstrap that left the steps without their dependencies fails the report whatever the
  // (all skipped) steps would otherwise say (ADR-0043 D17); the same rule the wire guard applies.
  if (
    dependencies !== undefined &&
    VERIFICATION_DEPENDENCY_FAILURE_STATES.has(dependencies.state)
  ) {
    return "failed";
  }
  // Array.prototype.every is vacuously true on an empty array: without this guard, a plan with
  // zero steps would report "passed" — the worst possible answer to "nothing ran" for a gate whose
  // output decides whether generated code is considered correct (KEIKO-0848). Every caller reaches
  // this function through finishReport (both the normal path and the root-mismatch path), so this
  // one guard closes the gap for every runVerification caller, including SDK consumers that have
  // no guard of their own.
  if (results.length === 0) {
    return "failed";
  }
  const allOk = results.every((r) => r.status === "passed" || r.status === "skipped");
  if (!allOk) return "failed";
  // The same KEIKO-0848 class one step further (#3390): a report whose EVERY step was skipped
  // executed nothing either. Reporting it as "passed" told the coding model its verification had
  // succeeded, while the verified-commit proof -- which requires at least one executed, passing
  // step -- refused that very report; the model then abandoned the delivery (rehearsal run-16).
  // "skipped" is the honest word: nothing failed, and nothing was proven.
  return results.some((r) => r.status === "passed") ? "passed" : "skipped";
}

function countByStatus(results: readonly VerificationResult[]): Record<VerificationStatus, number> {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    VerificationStatus,
    number
  >;
  for (const r of results) {
    counts[r.status] += 1;
  }
  return counts;
}

function finishReport(
  workspaceRoot: string,
  results: readonly VerificationResult[],
  cancelled: boolean,
  startedAtMs: number,
  now: () => number,
  dependencies?: VerificationDependencySummary,
): VerificationReport {
  return {
    workspaceRoot,
    results,
    overallStatus: overallStatus(results, cancelled, dependencies),
    startedAtMs,
    durationMs: now() - startedAtMs,
    counts: countByStatus(results),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

// Whether the bootstrap left the workspace fit for its script steps.
function dependenciesReady(outcome: DependencyBootstrapOutcome | undefined): boolean {
  return (
    outcome === undefined ||
    outcome.summary.state === "none" ||
    outcome.summary.state === "current" ||
    outcome.summary.state === "installed"
  );
}

// ADR-0043 D17: decide about, and if needed install, the workspace's dependencies before the first
// script step. Nothing is done for a plan without a runnable step, or when the caller left the
// bootstrap off; a bootstrap that did not succeed hands its redacted output tail to the caller's
// seam exactly like a failed step does.
async function bootstrapDependencies(
  plan: VerificationPlan,
  deps: VerificationDeps,
  baseSpawn: SpawnFn,
): Promise<DependencyBootstrapOutcome | undefined> {
  if (plan.steps.every((step) => step.skipReason !== undefined)) return undefined;
  const fs = deps.fs ?? nodeWorkspaceFs;
  const bootstrapPlan = planDependencyBootstrap(deps.workspace, fs);
  if (bootstrapPlan.kind === "none") return undefined;
  const outcome = await runDependencyBootstrap(bootstrapPlan, bootstrapDeps(deps, fs, baseSpawn));
  if (outcome.excerpt !== undefined) {
    deps.onStepOutput?.({ step: "dependencies", scriptName: undefined, excerpt: outcome.excerpt });
  }
  return outcome;
}

function bootstrapDeps(
  deps: VerificationDeps,
  fs: WorkspaceFs,
  baseSpawn: SpawnFn,
): DependencyBootstrapDeps {
  return {
    workspace: deps.workspace,
    fs,
    spawn: baseSpawn,
    processEnv: deps.processEnv ?? process.env,
    now: deps.now ?? Date.now,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.resolveExecutable === undefined ? {} : { resolveExecutable: deps.resolveExecutable }),
    ...(deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }),
    ...(deps.sandboxAvailability === undefined
      ? {}
      : { sandboxAvailability: deps.sandboxAvailability }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

// Every planned step, unexecuted, when the bootstrap left the workspace without its dependencies.
function dependenciesUnavailableResults(
  plan: VerificationPlan,
  outcome: DependencyBootstrapOutcome,
): readonly VerificationResult[] {
  return plan.steps.map((step) =>
    skippedResult({
      ...step,
      skipReason: step.skipReason ?? `dependencies unavailable: bootstrap ${outcome.summary.state}`,
    }),
  );
}

// Forwards a non-passing step's redacted output tail to the caller's seam (ADR-0126 D3).
function reportStepOutput(
  deps: VerificationDeps,
  step: VerificationStep,
  run: StepRun,
  result: VerificationResult,
): void {
  if (result.status === "passed" || result.status === "skipped" || run.result === undefined) return;
  deps.onStepOutput?.({
    step: step.kind,
    scriptName: step.scriptName,
    excerpt: outputExcerpt(run.result),
  });
}

function rootMismatchReport(
  plan: VerificationPlan,
  workspaceRoot: string,
  startedAtMs: number,
  now: () => number,
): VerificationReport {
  const results = plan.steps.map((step) =>
    deniedResult(step, "verification plan rejected: workspace root mismatch"),
  );
  return finishReport(workspaceRoot, results, false, startedAtMs, now);
}

function preExecutionResult(
  step: VerificationStep,
  cancelled: boolean,
  signal: AbortSignal | undefined,
): { readonly result: VerificationResult; readonly cancelled: boolean } | undefined {
  if (!isValidVerificationStep(step)) {
    return {
      result: deniedResult(step, "verification plan rejected: unsupported step shape"),
      cancelled,
    };
  }
  if (cancelled) {
    return { result: cancelledResult(step), cancelled };
  }
  if (step.skipReason !== undefined) {
    return { result: skippedResult(step), cancelled };
  }
  if (signal?.aborted === true) {
    return { result: cancelledResult(step), cancelled: true };
  }
  return undefined;
}

async function runPlanSteps(
  plan: VerificationPlan,
  deps: VerificationDeps,
  baseSpawn: SpawnFn,
  monitor: ResourceMonitor,
): Promise<{ readonly results: readonly VerificationResult[]; readonly cancelled: boolean }> {
  const results: VerificationResult[] = [];
  const mode = deps.networkEnforcement ?? "enforce-or-fail-closed";
  const available = deps.enforcedNetworkAvailable ?? false;
  let cancelled = false;
  for (const step of plan.steps) {
    const early = preExecutionResult(step, cancelled, deps.signal);
    if (early !== undefined) {
      results.push(early.result);
      cancelled = early.cancelled;
      continue;
    }
    const processTreeMemoryEnforced = monitor.canEnforceProcessTreeMemory();
    if (step.limits.maxMemoryBytes !== undefined && !processTreeMemoryEnforced) {
      results.push(
        deniedResult(
          step,
          "memory ceiling requires complete process-tree monitoring on this host; refusing to execute without enforcement",
          false,
        ),
      );
      continue;
    }
    const resolution = resolveStepNetwork(step.limits, mode, available);
    if (resolution.kind === "fail-closed") {
      results.push(
        deniedResult(
          step,
          "network egress isolation required but no enforcing sandbox backend is available on this host; refusing to execute untrusted code",
        ),
      );
      continue;
    }
    const run = await runStep(step, deps, baseSpawn, monitor, resolution.network);
    const result = toResult(step, run, deps.workspace.root, processTreeMemoryEnforced);
    reportStepOutput(deps, step, run, result);
    results.push(result);
    cancelled ||= result.status === "cancelled";
  }
  return { results, cancelled };
}

export async function runVerification(
  plan: VerificationPlan,
  deps: VerificationDeps,
): Promise<VerificationReport> {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const workspaceRoot = deps.workspace.root;
  if (plan.workspaceRoot !== workspaceRoot) {
    return rootMismatchReport(plan, workspaceRoot, startedAtMs, now);
  }
  const baseSpawn = deps.spawn ?? nodeSpawnFn;
  // Awaited only when enabled: the default path keeps the exact scheduling it always had, so a
  // caller that aborts or advances timers right after starting a run sees no extra tick.
  const bootstrap =
    (deps.dependencyBootstrap ?? "off") === "auto"
      ? await bootstrapDependencies(plan, deps, baseSpawn)
      : undefined;
  if (bootstrap !== undefined && !dependenciesReady(bootstrap)) {
    const results = dependenciesUnavailableResults(plan, bootstrap);
    return finishReport(workspaceRoot, results, false, startedAtMs, now, bootstrap.summary);
  }
  const { results, cancelled } = await runPlanSteps(
    plan,
    deps,
    baseSpawn,
    deps.monitor ?? nodeResourceMonitor,
  );
  return finishReport(workspaceRoot, results, cancelled, startedAtMs, now, bootstrap?.summary);
}
