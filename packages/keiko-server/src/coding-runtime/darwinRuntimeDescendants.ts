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
// A command can also detach a process itself (`cmd &`, `nohup`); it is reparented to launchd at
// once and never appears below the service. The sweep therefore also ends a process of this user
// that launchd parents, that started while the service ran and whose working directory is inside
// the run's workspace: only the run's own commands start processes there in that window. The
// process listing and the directory lookup are the backend's capability
// (devLaneRuntimeProcessBackend.ts).

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
  /** Detached processes the sweep took over from launchd by the workspace rule above. */
  readonly adoptedCount: number;
  /** The listing failure that ended the sweep, when `outcome` is `listing-failed`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly rootPid: number;
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  readonly list: ProcessListing;
  /** Canonical roots a detached process of the run works in (the run's workspace). */
  readonly workspaceRoots?: readonly string[] | undefined;
  /** The working directory of each given process that the host reports. */
  readonly directoriesOf?:
    ((pids: readonly number[]) => Promise<ReadonlyMap<number, string>>) | undefined;
  readonly signal?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly settleMs?: number | undefined;
}

const SAMPLE_INTERVAL_MS = 500;
const SETTLE_MS = 150;
const SWEEP_ROUNDS = 5;
const LAUNCHD_PID = 1;
// `lstart` has one-second resolution: a process started in the service's first second may print
// the same second as the service itself.
const START_RESOLUTION_MS = 1_000;
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
    adoptedCount: { type: "integer", dataClass: "count", required: true },
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

/** `lsof -Fpn` output: a `p<pid>` record, then its `n<path>` name. */
export function parseWorkingDirectories(output: string): ReadonlyMap<number, string> {
  const directories = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && Number.isSafeInteger(pid))
      directories.set(pid, line.slice(1));
  }
  return directories;
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

function startedAtMs(started: string): number | undefined {
  const parsed = Date.parse(started);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inside(directory: string | undefined, roots: readonly string[]): boolean {
  return (
    directory !== undefined &&
    roots.some((root) => directory === root || directory.startsWith(`${root}/`))
  );
}

/** Launchd's children of this listing that started no earlier than the service. */
function detachedCandidates(
  rows: readonly ProcessIdentity[],
  notBefore: number,
  excluded: ReadonlySet<number>,
): readonly ProcessIdentity[] {
  return rows.filter((row) => {
    const started = startedAtMs(row.started);
    return (
      row.ppid === LAUNCHD_PID &&
      !excluded.has(row.pid) &&
      started !== undefined &&
      started >= notBefore
    );
  });
}

export class RuntimeDescendantTracker {
  private readonly known = new Map<number, string>();
  private readonly adopted = new Set<number>();
  private rootStartedAtMs: number | undefined;
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
      this.rememberRootStart(rows);
      this.remember(descendantsOf(rows, new Set([this.options.rootPid])));
    } catch {
      recordFailedSample(this.counters);
    }
  }

  private rememberRootStart(rows: readonly ProcessIdentity[]): void {
    if (this.rootStartedAtMs !== undefined) return;
    const root = rows.find((row) => row.pid === this.options.rootPid);
    if (root !== undefined) this.rootStartedAtMs = startedAtMs(root.started);
  }

  /**
   * Detached processes of the run: launchd's children of this user that started while the service
   * ran and work inside the run's workspace. Without a recorded service start, nothing is adopted.
   */
  private async detached(
    rows: readonly ProcessIdentity[],
    excluded: ReadonlySet<number>,
  ): Promise<readonly ProcessIdentity[]> {
    const { workspaceRoots, directoriesOf } = this.options;
    if (this.rootStartedAtMs === undefined || workspaceRoots === undefined) return [];
    if (directoriesOf === undefined || workspaceRoots.length === 0) return [];
    const candidates = detachedCandidates(
      rows,
      this.rootStartedAtMs - START_RESOLUTION_MS,
      excluded,
    );
    if (candidates.length === 0) return [];
    const directories = await directoriesOf(candidates.map((row) => row.pid));
    const owned = candidates.filter((row) => inside(directories.get(row.pid), workspaceRoots));
    for (const row of owned) this.adopted.add(row.pid);
    this.remember(owned);
    return owned;
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
      const targets = await this.sweepTargets(await this.options.list());
      if (targets.length === 0) return this.result(signalled, 0);
      for (const target of targets) {
        signalled.add(target.pid);
        this.signalOnce(target.pid, round === 0 ? "SIGTERM" : "SIGKILL");
      }
      await delay(this.options.settleMs ?? SETTLE_MS);
    }
    return this.result(signalled, (await this.sweepTargets(await this.options.list())).length);
  }

  private async sweepTargets(
    rows: readonly ProcessIdentity[],
  ): Promise<readonly ProcessIdentity[]> {
    const below = this.targets(rows);
    const detached = await this.detached(rows, new Set(below.map((row) => row.pid)));
    // Adopted processes are recorded now, so the same selection includes them and theirs.
    return detached.length === 0 ? below : this.targets(rows);
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
      adoptedCount: this.adopted.size,
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
        adoptedCount: sweep.adoptedCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(sweep.error === undefined
          ? {}
          : { frames: keikoStackFrames(sweep.error), causeChain: causeChain(sweep.error) }),
      },
    ),
  );
}
