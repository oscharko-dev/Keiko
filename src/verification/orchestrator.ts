// The verification orchestrator (ADR-0007 D2–D5). Runs each plan step sequentially through the
// UNCHANGED #6 runCommand, applying per-command resource limits, honest appliedLimits, memory
// monitoring via a SpawnFn wrapper + ResourceMonitor seam (never modifying src/tools), cross-step
// cancellation, and a redacted output digest. Error handling lives only at this IO boundary; the
// classification it feeds is pure.

import { redact } from "../gateway/redaction.js";
import {
  DEFAULT_COMMAND_RULES,
  DEFAULT_SANDBOX_POLICY,
  nodeSpawnFn,
  runCommand,
  type CommandRule,
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
  type SpawnFn,
} from "../tools/index.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import type { WorkspaceInfo } from "../workspace/index.js";
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

export interface VerificationDeps {
  readonly workspace: WorkspaceInfo;
  readonly signal?: AbortSignal | undefined;
  // Base SpawnFn the orchestrator wraps with the memory monitor; defaults to the #6 node spawn.
  readonly spawn?: SpawnFn | undefined;
  readonly monitor?: ResourceMonitor | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly fs?: WorkspaceFs | undefined;
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

// Maps a step's resource limits onto a #6 SandboxPolicy: wall-time and output-size are enforced by
// runCommand; network is passed through (documented-not-enforced). Memory is NOT a SandboxPolicy
// field — it is handled by the SpawnFn-wrapper monitor, so it does not appear here.
function policyForStep(limits: VerificationResourceLimits): SandboxPolicy {
  return {
    ...DEFAULT_SANDBOX_POLICY,
    maxOutputBytes: limits.maxOutputBytes,
    defaultTimeoutMs: limits.wallTimeMs,
    network: limits.network,
  };
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
      buildRunDeps(deps, step, spawn),
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
): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: policyForStep(step.limits),
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

function toResult(step: VerificationStep, run: StepRun): VerificationResult {
  const status = classifyOutcome({
    skipped: false,
    result: run.result,
    error: run.error,
    abortReason: run.abortReason,
  });
  const breached = breachedDimension(status, run.abortReason, run.result);
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
    appliedLimits: buildAppliedLimits(step.limits, breached),
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
  let cancelled = false;
  for (const step of plan.steps) {
    const early = preExecutionResult(step, cancelled, deps.signal);
    if (early !== undefined) {
      results.push(early.result);
      cancelled = early.cancelled;
      continue;
    }
    const result = toResult(step, await runStep(step, deps, baseSpawn, monitor));
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
