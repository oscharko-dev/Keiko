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
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
  type SpawnFn,
} from "../tools/index.js";
import { nodeWorkspaceFs, type WorkspaceFs, type WorkspaceInfo } from "../workspace/index.js";
import { classifyOutcome, type AbortReason } from "./classify.js";
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

const OUTPUT_DIGEST_BYTES = 4_096;

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

// A redacted, byte-capped digest of stdout+stderr. #6 already redacts and caps each stream; we
// re-redact the COMPOSED string (defence in depth) and clamp to a small digest for the report.
function outputDigest(result: CommandResult | undefined): string {
  if (result === undefined) {
    return "";
  }
  const combined = `${result.stdout}${result.stderr}`;
  const capped = Buffer.from(combined, "utf8").subarray(0, OUTPUT_DIGEST_BYTES).toString("utf8");
  return redact(capped);
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
    return { result, error: undefined, abortReason };
  } catch (error) {
    return { result: undefined, error, abortReason };
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
    commandRules: DEFAULT_COMMAND_RULES,
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
    durationMs: run.result?.durationMs ?? 0,
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

export async function runVerification(
  plan: VerificationPlan,
  deps: VerificationDeps,
): Promise<VerificationReport> {
  const now = deps.now ?? Date.now;
  const baseSpawn = deps.spawn ?? nodeSpawnFn;
  const monitor = deps.monitor ?? nodeResourceMonitor;
  const startedAtMs = now();
  const results: VerificationResult[] = [];
  let cancelled = false;
  for (const step of plan.steps) {
    if (cancelled) {
      results.push(cancelledResult(step));
      continue;
    }
    if (step.skipReason !== undefined) {
      results.push(skippedResult(step));
      continue;
    }
    if (deps.signal?.aborted === true) {
      cancelled = true;
      results.push(cancelledResult(step));
      continue;
    }
    const run = await runStep(step, deps, baseSpawn, monitor);
    const result = toResult(step, run);
    results.push(result);
    if (result.status === "cancelled") {
      cancelled = true;
    }
  }
  return {
    workspaceRoot: plan.workspaceRoot,
    results,
    overallStatus: overallStatus(results, cancelled),
    startedAtMs,
    durationMs: now() - startedAtMs,
    counts: countByStatus(results),
  };
}
