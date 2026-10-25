import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SandboxMembership } from "./darwinSandboxMembership.js";

// #3899 AC2 / #3901 AC3: on macOS the runtime's shell children leave its process group (the
// original service starts each in its own), and a command can detach a process itself (`cmd &`,
// `nohup`, `setsid`); launchd adopts it at once. A group kill therefore ends only the service. Once
// the service has exited, the sweep ends every process of the run's sandbox instance through the
// run's member (darwinSandboxMembership.ts), which asks the kernel and signals from inside the
// instance: ownership is the kernel's, and a process of anyone else is never signalled.
//
// The proof uses no listing and no process identity, so a PID reused a moment before, a listing
// that is already stale, or a host whose own processes come and go cannot mislead it (PR #4064
// review). The member answers whether any process of the instance besides itself exists. While one
// does, it sends SIGKILL to all of them in one broadcast and asks again: a process the broadcast
// missed because it was forked during it is reached by the next one. When the kernel answers that
// none exists, none can appear either: only a process of the instance can start another, and the
// member forks nothing. That answer is the end. A process that outlives every broadcast
// (`survivors`), a run without a member (`unproven`, the gateway profile has no shell) and a member
// that no longer answers (`membership-unavailable`) leave the end unproven; none of them is ever
// reported as a clean end, and without the member nothing is signalled at all.

export type DescendantSweepOutcome =
  "clean" | "reaped" | "survivors" | "unproven" | "membership-unavailable";

export interface DescendantSweep {
  readonly outcome: DescendantSweepOutcome;
  /** SIGKILL broadcasts the member sent to the run's remaining processes. */
  readonly roundCount: number;
  /** Times the member asked the kernel whether any process of the run remains. */
  readonly checkCount: number;
  /** The failure that ended the proof, when `outcome` is `membership-unavailable`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  /** The kernel's answer for the run's sandbox instance; absent when the run has no member. */
  readonly membership?: SandboxMembership | undefined;
  readonly settleMs?: number | undefined;
}

// A killed process leaves the instance once the kernel has torn it down, usually within a
// millisecond; a large one takes longer. The wait doubles from SETTLE_MS up to MAX_SETTLE_MS, so the
// bounded rounds allow about two seconds before the remaining processes count as survivors.
const SETTLE_MS = 2;
const MAX_SETTLE_MS = 50;
const KILL_ROUNDS = 50;

export const RUNTIME_DESCENDANTS_SWEPT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.descendants.swept",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.darwinRuntimeDescendants.recordDescendantSweep",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["clean", "reaped", "survivors", "unproven", "membership-unavailable"],
    },
    roundCount: { type: "integer", dataClass: "count", required: true },
    checkCount: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [
    { field: "outcome", values: ["survivors", "unproven", "membership-unavailable"] },
  ],
  failureClasses: ["coding-runtime-descendant-sweep"],
  proofIds: ["coding-runtime.descendants.swept.emitted-line"],
  releaseImpact: "patch",
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function isProven(outcome: DescendantSweepOutcome): boolean {
  return outcome === "clean" || outcome === "reaped";
}

/** Whether a sweep proves that the run's execution has ended. */
export function sweepProvesEnd(sweep: DescendantSweep): boolean {
  return isProven(sweep.outcome);
}

interface SweepCounters {
  rounds: number;
  checks: number;
  /** The failure that ended the proof; the sweep's line carries its frames and cause chain. */
  failure?: unknown;
}

// The first failure that ended the proof is the one the sweep's line reports.
function recordSweepFailure(counters: SweepCounters, error: unknown): void {
  counters.failure ??= error;
}

export class RuntimeDescendantTracker {
  private readonly counters: SweepCounters = { rounds: 0, checks: 0 };
  private swept: Promise<DescendantSweep> | undefined;

  public constructor(private readonly options: DescendantTrackerOptions) {}

  /** Ends what the exited service left behind, once; later callers share the first result. */
  public sweep(): Promise<DescendantSweep> {
    this.swept ??= this.runSweep();
    return this.swept;
  }

  private async runSweep(): Promise<DescendantSweep> {
    const startedAt = performance.now();
    const result = await this.sweepOnce();
    this.options.membership?.close();
    recordDescendantSweep(this.options, result, performance.now() - startedAt);
    return result;
  }

  private async sweepOnce(): Promise<DescendantSweep> {
    const { membership } = this.options;
    // Without the member nothing is signalled: only the kernel's answer may reach a process.
    if (membership === undefined) return this.result("unproven");
    try {
      return await this.endAll(membership);
    } catch (error) {
      // A member that no longer answers proves nothing; the line carries the failure's evidence.
      recordSweepFailure(this.counters, error);
      return this.result("membership-unavailable");
    }
  }

  /** Broadcasts SIGKILL through the member until the kernel answers that no process remains. */
  private async endAll(membership: SandboxMembership): Promise<DescendantSweep> {
    while (await this.occupied(membership)) {
      if (this.counters.rounds >= KILL_ROUNDS) return this.result("survivors");
      const settleMs = this.options.settleMs ?? SETTLE_MS;
      await membership.killAll();
      await delay(Math.min(MAX_SETTLE_MS, settleMs * 2 ** this.counters.rounds));
      this.counters.rounds += 1;
    }
    return this.result(this.counters.rounds > 0 ? "reaped" : "clean");
  }

  private occupied(membership: SandboxMembership): Promise<boolean> {
    this.counters.checks += 1;
    return membership.occupied();
  }

  private result(outcome: DescendantSweepOutcome): DescendantSweep {
    const error = this.counters.failure;
    return {
      outcome,
      roundCount: this.counters.rounds,
      checkCount: this.counters.checks,
      ...(error === undefined ? {} : { error }),
    };
  }
}

export function recordDescendantSweep(
  target: { readonly activityLog: ServerLogSink; readonly runId: string },
  sweep: DescendantSweep,
  durationMs: number,
): void {
  const { activityLog, runId } = target;
  const failed = !isProven(sweep.outcome);
  activityLog.write(
    activityLogEvent(
      RUNTIME_DESCENDANTS_SWEPT_OPERATION,
      failed
        ? { level: "warn", correlationId: runId, errorKind: "internal" }
        : { level: "info", correlationId: runId },
      {
        outcome: sweep.outcome,
        roundCount: sweep.roundCount,
        checkCount: sweep.checkCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(sweep.error === undefined
          ? {}
          : { frames: keikoStackFrames(sweep.error), causeChain: causeChain(sweep.error) }),
      },
    ),
  );
}
