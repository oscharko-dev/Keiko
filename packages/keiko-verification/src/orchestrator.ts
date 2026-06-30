// The verification orchestrator (ADR-0007 D2–D5). Runs each plan step sequentially through the
// UNCHANGED #6 runCommand, applying per-command resource limits, honest appliedLimits, memory
// monitoring via a SpawnFn wrapper + ResourceMonitor seam (never modifying src/tools), cross-step
// cancellation, and a redacted output digest. Error handling lives only at this IO boundary; the
// classification it feeds is pure.

import { redact } from "@oscharko-dev/keiko-security";
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
import { classifyScripts } from "./detect.js";
import { buildAppliedLimits, type BreachedDimension } from "./limits.js";
import { nodeResourceMonitor, type ResourceMonitor } from "./monitor.js";
import type {
  VerificationPlan,
  VerificationReport,
  VerificationResourceLimits,
  VerificationResult,
  VerificationStatus,
  VerificationStep,
} from "./types.js";

// How the orchestrator treats a step that declares `limits.network === "none"` (ADR-0043).
//   - "inherit"               — never enforce egress; every step runs with network:"inherit". This is
//                               the default and preserves the historical behaviour exactly for every
//                               existing caller (the harness verification path, the CLI, the run engine).
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
  // Egress-enforcement policy for `network:"none"` steps (default "inherit" = historical behaviour).
  readonly networkEnforcement?: NetworkEnforcementMode | undefined;
  // Whether an enforcing sandbox backend is available on this host for a network:"none" run. The caller
  // probes keiko-sandbox once (a synchronous PATH/binary check) and injects the result, so the
  // orchestrator stays free of a keiko-sandbox dependency and tests stay deterministic. Default false.
  readonly enforcedNetworkAvailable?: boolean | undefined;
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
// which `buildAppliedLimits` reports honestly. The default mode resolves to "inherit", so existing
// callers are unaffected.
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
// enforcing backend is available. The default mode ("inherit") and any step that does not declare
// `network:"none"` always run with "inherit" — byte-identical to the historical orchestrator. Only an
// explicit enforce-* mode on a `network:"none"` step requests enforcement; when no backend is available
// it degrades honestly or fails closed per the mode.
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

function deniedResult(step: VerificationStep, reason: string): VerificationResult {
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
    appliedLimits: buildAppliedLimits(step.limits, undefined),
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
    .split("\\")
    .join("/")
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
  if (step.scriptName !== undefined || step.command !== "npx" || step.args.length < 2) {
    return false;
  }
  if (step.args[0] === "vitest") {
    return (
      step.args[1] === "run" &&
      step.args.length >= 3 &&
      step.args.slice(2).every(isGeneratedTargetPath)
    );
  }
  if (step.args[0] === "jest") {
    return step.args.length >= 2 && step.args.slice(1).every(isGeneratedTargetPath);
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
    appliedLimits: buildAppliedLimits(step.limits, undefined),
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
    appliedLimits: buildAppliedLimits(step.limits, undefined),
    detail: "cancelled before execution",
  };
}

// Honest network-enforcement reporting (ADR-0043 D4): the attestation is present only when this run
// requested network:"none" and keiko-sandbox wrapped the spawn; an inherited-network run carries no
// attestation, so this is false and the appliedLimits network row stays documented-not-enforced.
function networkEnforcedOf(result: CommandResult | undefined): boolean {
  return result?.attestation?.networkEnforced ?? false;
}

function toResult(step: VerificationStep, run: StepRun): VerificationResult {
  const status = classifyOutcome({
    skipped: false,
    result: run.result,
    error: run.error,
    abortReason: run.abortReason,
  });
  const breached = breachedDimension(status, run.abortReason, run.result);
  const networkEnforced = networkEnforcedOf(run.result);
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
    appliedLimits: buildAppliedLimits(step.limits, breached, networkEnforced),
    detail: detailFor(status, run),
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
): VerificationStatus {
  if (cancelled) {
    return "cancelled";
  }
  const allOk = results.every((r) => r.status === "passed" || r.status === "skipped");
  return allOk ? "passed" : "failed";
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
): VerificationReport {
  return {
    workspaceRoot,
    results,
    overallStatus: overallStatus(results, cancelled),
    startedAtMs,
    durationMs: now() - startedAtMs,
    counts: countByStatus(results),
  };
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
  const mode = deps.networkEnforcement ?? "inherit";
  const available = deps.enforcedNetworkAvailable ?? false;
  let cancelled = false;
  for (const step of plan.steps) {
    const early = preExecutionResult(step, cancelled, deps.signal);
    if (early !== undefined) {
      results.push(early.result);
      cancelled = early.cancelled;
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
    const result = toResult(
      step,
      await runStep(step, deps, baseSpawn, monitor, resolution.network),
    );
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
  const { results, cancelled } = await runPlanSteps(
    plan,
    deps,
    deps.spawn ?? nodeSpawnFn,
    deps.monitor ?? nodeResourceMonitor,
  );
  return finishReport(workspaceRoot, results, cancelled, startedAtMs, now);
}
