import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  SandboxMembershipUnavailableError,
  type SandboxMembership,
} from "./darwinSandboxMembership.js";

// #3899 AC2 / #3901 AC3: on macOS the runtime's shell children leave its process group (the
// original service starts each in its own), and a command can detach a process itself (`cmd &`,
// `nohup`, `setsid`); launchd adopts it at once. A group kill therefore ends only the service. Once
// the service has exited, the sweep ends every process of the run's sandbox instance: the run's
// member answers which of this user's processes those are (darwinSandboxMembership.ts), so
// ownership is the kernel's, not an inference from a parent link, a working directory or a start
// time, and a process of anyone else is never signalled. The sweep repeats until a listing holds no
// member; only members start members, so none can appear afterwards, and only then is the run's
// execution proven to have ended. Without an answering member (a profile with no shell, or a member
// that ended), the descendants recorded by PID and start time while the service ran are still ended,
// but the sweep reports `unproven`, never clean: a child forked between samples and orphaned before
// the sweep is not seen (ADR-0140 D3). The process listing is the backend's capability
// (devLaneRuntimeProcessBackend.ts).

/** One process: its parent, its state and the start time that tells it apart from a PID reuse. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** `ps` state; a zombie (`Z`) has already ended and holds no execution. */
  readonly state: string;
  readonly started: string;
}

export type ProcessListing = () => Promise<readonly ProcessIdentity[]>;

export type DescendantSweepOutcome =
  "clean" | "reaped" | "survivors" | "listing-failed" | "membership-unavailable" | "unproven";

export interface DescendantSweep {
  readonly outcome: DescendantSweepOutcome;
  /** Distinct descendants recorded while the service ran or found below them during the sweep. */
  readonly trackedCount: number;
  /** Distinct processes the kernel confirmed as members of the run's sandbox during the sweep. */
  readonly memberCount: number;
  /** Distinct processes the sweep signalled. */
  readonly signalledCount: number;
  /** Processes of the run still alive after the last round. */
  readonly survivorCount: number;
  /** Samples of the running service the listing could not take. */
  readonly failedSampleCount: number;
  /** Signals the host refused for a reason other than the process having already ended. */
  readonly refusedSignalCount: number;
  /** The failure that ended the proof, when `outcome` is `listing-failed` or `membership-unavailable`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly rootPid: number;
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  readonly list: ProcessListing;
  /** The kernel's answer to which processes belong to the run; absent when the run has no member. */
  readonly membership?: SandboxMembership | undefined;
  readonly signal?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly settleMs?: number | undefined;
}

const SAMPLE_INTERVAL_MS = 500;
const SETTLE_MS = 150;
const SWEEP_ROUNDS = 5;
// Matched against a trimmed line: the digit, space and non-space classes alternate, so the match is
// linear (no backtracking between adjacent repetitions).
const PROCESS_ROW = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S.*)$/u;

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
      values: [
        "clean",
        "reaped",
        "survivors",
        "listing-failed",
        "membership-unavailable",
        "unproven",
      ],
    },
    trackedCount: { type: "integer", dataClass: "count", required: true },
    memberCount: { type: "integer", dataClass: "count", required: true },
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
  diagnosticWhen: [
    {
      field: "outcome",
      values: ["survivors", "listing-failed", "membership-unavailable", "unproven"],
    },
  ],
  failureClasses: ["coding-runtime-descendant-sweep"],
  proofIds: ["coding-runtime.descendants.swept.emitted-line"],
  releaseImpact: "patch",
});

export function parseProcessListing(output: string): readonly ProcessIdentity[] {
  return output.split("\n").flatMap((line) => {
    const match = PROCESS_ROW.exec(line.trim());
    if (match?.[3] === undefined || match[4] === undefined) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3], started: match[4] }];
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
  /** The failure that ended the proof; the sweep's line carries its frames and cause chain. */
  failure?: unknown;
}

// A missed sample only narrows what the sweep can see; it is counted onto the sweep's line.
function recordFailedSample(counters: SweepCounters): void {
  counters.failedSamples += 1;
}

// The first failure that ended the proof is the one the sweep's line reports.
function recordSweepFailure(counters: SweepCounters, error: unknown): void {
  counters.failure ??= error;
}

// ESRCH: the process ended between the listing and the signal. Any other refusal leaves it alive,
// so the next round's listing counts it, and the refusal is counted onto the sweep's line.
function recordSignalFailure(counters: SweepCounters, error: unknown): void {
  if ((error as { readonly code?: unknown } | null)?.code !== "ESRCH") counters.refusedSignals += 1;
}

function isProven(outcome: DescendantSweepOutcome): boolean {
  return outcome === "clean" || outcome === "reaped";
}

/** Whether a sweep proves that the run's execution has ended. */
export function sweepProvesEnd(sweep: DescendantSweep): boolean {
  return isProven(sweep.outcome) && sweep.survivorCount === 0;
}

export class RuntimeDescendantTracker {
  private readonly known = new Map<number, string>();
  private readonly members = new Set<number>();
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
      const rows = await this.options.list();
      this.remember(descendantsOf(rows, new Set([this.options.rootPid])));
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
    return [...live, ...below].filter((row) => !row.state.startsWith("Z"));
  }

  private async runSweep(): Promise<DescendantSweep> {
    clearInterval(this.timer);
    this.timer = undefined;
    const startedAt = performance.now();
    await this.sampling;
    const result = await this.sweepOnce();
    this.options.membership?.close();
    recordDescendantSweep(this.options, result, performance.now() - startedAt);
    return result;
  }

  private async sweepOnce(): Promise<DescendantSweep> {
    const signalled = new Set<number>();
    const { membership } = this.options;
    if (membership === undefined) return this.reapRecorded(signalled, "unproven");
    try {
      return await this.reapMembers(membership, signalled);
    } catch (error) {
      // Without the member's answer nothing proves the end; what was recorded is still ended.
      recordSweepFailure(this.counters, error);
      return error instanceof SandboxMembershipUnavailableError
        ? this.reapRecorded(signalled, "membership-unavailable")
        : this.result("listing-failed", signalled, 0);
    }
  }

  /** Ends every member of the run's sandbox until a listing holds none. */
  private async reapMembers(
    membership: SandboxMembership,
    signalled: Set<number>,
  ): Promise<DescendantSweep> {
    for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
      const live = await this.liveMembers(membership);
      if (live.length === 0) return this.result(undefined, signalled, 0);
      for (const pid of live) signalled.add(pid);
      await membership.signal(live, round === 0 ? "term" : "kill");
      await delay(this.options.settleMs ?? SETTLE_MS);
    }
    return this.result(undefined, signalled, (await this.liveMembers(membership)).length);
  }

  private async liveMembers(membership: SandboxMembership): Promise<readonly number[]> {
    const rows = await this.options.list();
    const live = await membership.members(
      rows.filter((row) => !row.state.startsWith("Z")).map((row) => row.pid),
    );
    for (const pid of live) this.members.add(pid);
    return live;
  }

  /** Ends the recorded descendants; without a member's answer this never proves the end. */
  private async reapRecorded(
    signalled: Set<number>,
    outcome: "membership-unavailable" | "unproven",
  ): Promise<DescendantSweep> {
    try {
      for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
        const targets = this.targets(await this.options.list());
        if (targets.length === 0) return this.result(outcome, signalled, 0);
        for (const target of targets) {
          signalled.add(target.pid);
          this.signalOnce(target.pid, round === 0 ? "SIGTERM" : "SIGKILL");
        }
        await delay(this.options.settleMs ?? SETTLE_MS);
      }
      const survivors = this.targets(await this.options.list()).length;
      return this.result(outcome, signalled, survivors);
    } catch (error) {
      recordSweepFailure(this.counters, error);
      return this.result("listing-failed", signalled, 0);
    }
  }

  private signalOnce(pid: number, signal: NodeJS.Signals): void {
    try {
      this.signal(pid, signal);
    } catch (error) {
      recordSignalFailure(this.counters, error);
    }
  }

  // `fixed` is the outcome of a sweep that proves nothing; a proving sweep derives its own.
  private result(
    fixed: DescendantSweepOutcome | undefined,
    signalled: ReadonlySet<number>,
    survivorCount: number,
  ): DescendantSweep {
    const error = this.counters.failure;
    let outcome: DescendantSweepOutcome = fixed ?? (signalled.size > 0 ? "reaped" : "clean");
    if (survivorCount > 0 && outcome !== "listing-failed") outcome = "survivors";
    return {
      outcome,
      trackedCount: this.known.size,
      memberCount: this.members.size,
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
  const failed = !isProven(sweep.outcome);
  activityLog.write(
    activityLogEvent(
      RUNTIME_DESCENDANTS_SWEPT_OPERATION,
      failed
        ? { level: "warn", correlationId: runId, errorKind: "internal" }
        : { level: "info", correlationId: runId },
      {
        outcome: sweep.outcome,
        trackedCount: sweep.trackedCount,
        memberCount: sweep.memberCount,
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
