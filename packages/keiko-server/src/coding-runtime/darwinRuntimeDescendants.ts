import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

// #3899 AC2: on macOS the runtime's shell children leave its process group (the original service
// starts each in its own), so a group kill ends only the service. A graceful stop is fine: the
// service ends its own children. A service that crashes cannot, and its children would outlive the
// run under launchd. While the service runs, its descendants are therefore recorded by PID and
// start time; once it has exited, every recorded process that is still the same process, and every
// descendant of one, is ended. Without an Endpoint Security monitor this is cleanup, not proof
// (ADR-0163 D4): a child forked after the last sample and orphaned before the sweep is not seen.
// The process listing itself is the backend's capability (devLaneRuntimeProcessBackend.ts).

/** One process: its parent and the start time that tells it apart from a later reuse of its PID. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly started: string;
}

export type ProcessListing = () => Promise<readonly ProcessIdentity[]>;

export interface DescendantSweep {
  readonly outcome: "clean" | "reaped" | "survivors" | "listing-failed";
  /** Distinct descendants recorded while the service ran or found during the sweep. */
  readonly trackedCount: number;
  /** Distinct processes the sweep signalled. */
  readonly signalledCount: number;
  /** Recorded processes still alive after the last round. */
  readonly survivorCount: number;
  /** Samples of the running service the listing could not take. */
  readonly failedSampleCount: number;
  /** Signals the host refused for a reason other than the process having already ended. */
  readonly refusedSignalCount: number;
  /** The listing failure that ended the sweep, when `outcome` is `listing-failed`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly rootPid: number;
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  readonly list: ProcessListing;
  readonly signal?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly settleMs?: number | undefined;
}

const SAMPLE_INTERVAL_MS = 500;
const SETTLE_MS = 150;
const SWEEP_ROUNDS = 5;
// Matched against a trimmed line: the digit, space and start-time classes are disjoint, so the
// match is linear (no backtracking between adjacent repetitions).
const PROCESS_ROW = /^(\d+)\s+(\d+)\s+(\S.*)$/u;

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
      values: ["clean", "reaped", "survivors", "listing-failed"],
    },
    trackedCount: { type: "integer", dataClass: "count", required: true },
    signalledCount: { type: "integer", dataClass: "count", required: true },
    survivorCount: { type: "integer", dataClass: "count", required: true },
    failedSampleCount: { type: "integer", dataClass: "count", required: true },
    refusedSignalCount: { type: "integer", dataClass: "count", required: true },
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
  diagnosticWhen: [{ field: "outcome", values: ["survivors", "listing-failed"] }],
  failureClasses: ["coding-runtime-descendant-sweep"],
  proofIds: ["coding-runtime.descendants.swept.emitted-line"],
  releaseImpact: "patch",
});

export function parseProcessListing(output: string): readonly ProcessIdentity[] {
  return output.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line.trim());
    if (match?.[3] === undefined) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] }];
  });
}

/** Every process below the given roots in one listing, roots excluded. */
export function descendantsOf(
  rows: readonly ProcessIdentity[],
  roots: ReadonlySet<number>,
): readonly ProcessIdentity[] {
  const children = new Map<number, ProcessIdentity[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const found: ProcessIdentity[] = [];
  const pending = [...roots];
  const seen = new Set(roots);
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

interface SweepCounters {
  failedSamples: number;
  refusedSignals: number;
}

// A missed sample only narrows what the sweep can see; it is counted onto the sweep's line.
function recordFailedSample(counters: SweepCounters): void {
  counters.failedSamples += 1;
}

// ESRCH: the process ended between the listing and the signal. Any other refusal leaves it alive,
// so the next round's listing counts it, and the refusal is counted onto the sweep's line.
function recordSignalFailure(counters: SweepCounters, error: unknown): void {
  if ((error as { readonly code?: unknown } | null)?.code !== "ESRCH") counters.refusedSignals += 1;
}

export class RuntimeDescendantTracker {
  private readonly known = new Map<number, string>();
  private readonly counters: SweepCounters = { failedSamples: 0, refusedSignals: 0 };
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private timer: NodeJS.Timeout | undefined;
  private sampling: Promise<void> = Promise.resolve();
  private swept: Promise<DescendantSweep> | undefined;

  public constructor(private readonly options: DescendantTrackerOptions) {
    this.signal = options.signal ?? signalProcess;
  }

  /** Samples the service's descendants until the sweep starts. */
  public start(): void {
    if (this.timer !== undefined || this.swept !== undefined) return;
    this.timer = setInterval(() => {
      this.sampling = this.sampling.then(() => this.sample());
    }, this.options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  /** Ends what the exited service left behind, once; later callers share the first result. */
  public sweep(): Promise<DescendantSweep> {
    this.swept ??= this.runSweep();
    return this.swept;
  }

  private async sample(): Promise<void> {
    if (this.swept !== undefined) return;
    try {
      this.remember(descendantsOf(await this.options.list(), new Set([this.options.rootPid])));
    } catch {
      recordFailedSample(this.counters);
    }
  }

  private remember(rows: readonly ProcessIdentity[]): void {
    for (const row of rows) this.known.set(row.pid, row.started);
  }

  /** Recorded processes that are still the same process, and everything below them. */
  private targets(rows: readonly ProcessIdentity[]): readonly ProcessIdentity[] {
    const live = rows.filter((row) => this.known.get(row.pid) === row.started);
    const below = descendantsOf(rows, new Set(live.map((row) => row.pid)));
    this.remember(below);
    return [...live, ...below];
  }

  private async runSweep(): Promise<DescendantSweep> {
    clearInterval(this.timer);
    this.timer = undefined;
    const startedAt = performance.now();
    await this.sampling;
    const signalled = new Set<number>();
    let result: DescendantSweep;
    try {
      result = await this.reap(signalled);
    } catch (error) {
      result = this.result(signalled, 0, error);
      recordDescendantSweep(this.options, result, performance.now() - startedAt);
      return result;
    }
    recordDescendantSweep(this.options, result, performance.now() - startedAt);
    return result;
  }

  private async reap(signalled: Set<number>): Promise<DescendantSweep> {
    for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
      const targets = this.targets(await this.options.list());
      if (targets.length === 0) return this.result(signalled, 0);
      for (const target of targets) {
        signalled.add(target.pid);
        this.signalOnce(target.pid, round === 0 ? "SIGTERM" : "SIGKILL");
      }
      await delay(this.options.settleMs ?? SETTLE_MS);
    }
    return this.result(signalled, this.targets(await this.options.list()).length);
  }

  private signalOnce(pid: number, signal: NodeJS.Signals): void {
    try {
      this.signal(pid, signal);
    } catch (error) {
      recordSignalFailure(this.counters, error);
    }
  }

  private result(
    signalled: ReadonlySet<number>,
    survivorCount: number,
    error?: unknown,
  ): DescendantSweep {
    let outcome: DescendantSweep["outcome"] = "clean";
    if (error !== undefined) outcome = "listing-failed";
    else if (survivorCount > 0) outcome = "survivors";
    else if (signalled.size > 0) outcome = "reaped";
    return {
      outcome,
      trackedCount: this.known.size,
      signalledCount: signalled.size,
      survivorCount,
      failedSampleCount: this.counters.failedSamples,
      refusedSignalCount: this.counters.refusedSignals,
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
  const failed = sweep.outcome === "survivors" || sweep.outcome === "listing-failed";
  activityLog.write(
    activityLogEvent(
      RUNTIME_DESCENDANTS_SWEPT_OPERATION,
      failed
        ? { level: "warn", correlationId: runId, errorKind: "internal" }
        : { level: "info", correlationId: runId },
      {
        outcome: sweep.outcome,
        trackedCount: sweep.trackedCount,
        signalledCount: sweep.signalledCount,
        survivorCount: sweep.survivorCount,
        failedSampleCount: sweep.failedSampleCount,
        refusedSignalCount: sweep.refusedSignalCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(sweep.error === undefined
          ? {}
          : { frames: keikoStackFrames(sweep.error), causeChain: causeChain(sweep.error) }),
      },
    ),
  );
}
