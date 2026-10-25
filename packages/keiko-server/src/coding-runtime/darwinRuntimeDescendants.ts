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
// the service has exited, the sweep ends every process of the run's sandbox instance. The run's
// member answers which of this user's processes those are (darwinSandboxMembership.ts) and sends
// every signal: ownership is the kernel's, and a process of anyone else is never signalled, even
// when its PID was reused a moment before.
//
// A listing is a snapshot, and a member may fork and exit between the listing and the member's
// answer, so an empty answer about an older listing proves nothing (PR #4064 review). The sweep
// therefore first freezes the run: each round lists, asks, and lists again. It proves the end only
// when every member the answer names was already stopped at the first listing, and no process that
// was running then and could have been a member has gone by the second: only a running process
// forks, so no member can have appeared since. One more answer, about the second listing, confirms
// it: a member that answer names and the first did not was missed. Otherwise the member stops what
// it found and the next round asks again. Once proven, the member kills the frozen members and a
// final answer must name none.
// Without the member's answer nothing is signalled and nothing is proven (`unproven`,
// `membership-unavailable`): a host signal could reach a reused PID. A run that keeps re-forking
// faster than a round, or a host whose processes keep ending in every round, stays `unproven`
// after the bounded rounds; that is never reported as a clean end. The process listing is the
// backend's capability (devLaneRuntimeProcessBackend.ts).
//
// A process that is still listed with the same PID and start time is the same process only if its
// PID cannot have been handed out again in between: `lstart` resolves seconds, so a PID reused
// within one second looks unchanged (PR #4064 review). macOS hands out PIDs in sequence, so a PID in
// use at the first listing is handed out again only once the counter reaches it again. Each listing
// therefore records the counter: the PID of a process started just before it reads the table and of
// one started just after. A PID the counter passed between the two listings is never taken for the
// same process, and a counter that wrapped proves nothing in that round. A counter that went once
// all the way round would look unwrapped, so a round that took longer than ROUND_WINDOW_MS proves
// nothing either: a full turn hands out 99,899 PIDs, and a saturated 16-core Apple silicon host
// handed out at most 19,000 a second (ADR-0140 D3), so it cannot complete one within the bound.

/** One process: its parent, its state and the start time that tells it apart from a PID reuse. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** `ps` state: `T` is stopped, `Z` a zombie that has already ended; anything else may run. */
  readonly state: string;
  readonly started: string;
}

/** One listing, and the PID counter just before it read the table and just after. */
export interface ProcessSnapshot {
  readonly rows: readonly ProcessIdentity[];
  readonly firstPid: number;
  readonly lastPid: number;
}

export type ProcessListing = () => Promise<ProcessSnapshot>;

export type DescendantSweepOutcome =
  "clean" | "reaped" | "survivors" | "unproven" | "listing-failed" | "membership-unavailable";

export interface DescendantSweep {
  readonly outcome: DescendantSweepOutcome;
  /** Distinct processes the kernel confirmed as members of the run's sandbox during the sweep. */
  readonly memberCount: number;
  /** Distinct members the sweep ended. */
  readonly signalledCount: number;
  /** Members still alive after the last check. */
  readonly survivorCount: number;
  /** Freeze rounds the sweep needed, or used up when the end stayed unproven. */
  readonly roundCount: number;
  /** The failure that ended the proof, when `outcome` is `listing-failed` or `membership-unavailable`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  readonly list: ProcessListing;
  /** The kernel's answer to which processes belong to the run; absent when the run has no member. */
  readonly membership?: SandboxMembership | undefined;
  /** When the run's service was started; every member started after it. */
  readonly startedAtMs: number;
  readonly settleMs?: number | undefined;
  /** Monotonic milliseconds; bounds how long a round may take to prove anything. */
  readonly clock?: (() => number) | undefined;
}

const SETTLE_MS = 50;
const LAUNCHD_PID = 1;
const FREEZE_ROUNDS = 20;
// Ten times below the shortest time a saturated host needed for a full PID turn (ADR-0140 D3).
const ROUND_WINDOW_MS = 500;
const END_CHECKS = 10;
// `lstart` has one-second resolution, and the service starts a moment before it is recorded.
const START_RESOLUTION_MS = 2_000;
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
        "unproven",
        "listing-failed",
        "membership-unavailable",
      ],
    },
    memberCount: { type: "integer", dataClass: "count", required: true },
    signalledCount: { type: "integer", dataClass: "count", required: true },
    survivorCount: { type: "integer", dataClass: "count", required: true },
    roundCount: { type: "integer", dataClass: "count", required: true },
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
      values: ["survivors", "unproven", "listing-failed", "membership-unavailable"],
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

const stopped = (row: ProcessIdentity): boolean => row.state.startsWith("T");
const ended = (row: ProcessIdentity): boolean => row.state.startsWith("Z");
const identity = (row: ProcessIdentity): string => `${String(row.pid)}@${row.started}`;

function isProven(outcome: DescendantSweepOutcome): boolean {
  return outcome === "clean" || outcome === "reaped";
}

/** Whether a sweep proves that the run's execution has ended. */
export function sweepProvesEnd(sweep: DescendantSweep): boolean {
  return isProven(sweep.outcome) && sweep.survivorCount === 0;
}

interface SweepCounters {
  readonly members: Set<number>;
  readonly signalled: Set<number>;
  rounds: number;
  /** The failure that ended the proof; the sweep's line carries its frames and cause chain. */
  failure?: unknown;
}

// The first failure that ended the proof is the one the sweep's line reports.
function recordSweepFailure(counters: SweepCounters, error: unknown): void {
  counters.failure ??= error;
}

export class RuntimeDescendantTracker {
  private readonly counters: SweepCounters = {
    members: new Set(),
    signalled: new Set(),
    rounds: 0,
  };
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
    // Without the member nothing is signalled: only the kernel's answer may name a target.
    if (membership === undefined) return this.result("unproven", 0);
    try {
      return await this.freezeAndEnd(membership);
    } catch (error) {
      recordSweepFailure(this.counters, error);
      return this.result(
        error instanceof SandboxMembershipUnavailableError
          ? "membership-unavailable"
          : "listing-failed",
        0,
      );
    }
  }

  private async freezeAndEnd(membership: SandboxMembership): Promise<DescendantSweep> {
    const clock = this.options.clock ?? ((): number => performance.now());
    for (let round = 1; round <= FREEZE_ROUNDS; round += 1) {
      this.counters.rounds = round;
      const startedAt = clock();
      const before = await this.options.list();
      const members = await this.members(membership, before.rows);
      const after = await this.options.list();
      const timely = clock() - startedAt <= ROUND_WINDOW_MS;
      // A run proven frozen is confirmed by one more answer, about the second listing: a member it
      // names that the first answer did not was missed, and is frozen in the next round instead.
      const missed =
        timely && this.frozen(before, members, after)
          ? await this.missed(membership, members, after.rows)
          : undefined;
      if (missed?.length === 0) return this.end(membership, members);
      await membership.signal([...members, ...(missed ?? [])], "stop");
      await delay(this.options.settleMs ?? SETTLE_MS);
    }
    return this.result("unproven", 0);
  }

  /** The members among a listing's live processes, as the run's member answers now. */
  private async members(
    membership: SandboxMembership,
    rows: readonly ProcessIdentity[],
  ): Promise<readonly number[]> {
    const members = await membership.members(
      rows.filter((row) => !ended(row)).map((row) => row.pid),
    );
    for (const pid of members) this.counters.members.add(pid);
    return members;
  }

  /** The members of the second listing that the answer about the first did not name. */
  private async missed(
    membership: SandboxMembership,
    members: readonly number[],
    rows: readonly ProcessIdentity[],
  ): Promise<readonly number[]> {
    const named = new Set(members);
    return (await this.members(membership, rows)).filter((pid) => !named.has(pid));
  }

  /**
   * Every member alive at `before` was stopped then: none the answer names was running, and no
   * process that was running at `before` and has gone by `after` can have been a member that forked
   * and exited before the answer. A process could not be one when it started before the run, or
   * when its parent is alive at `after` and no member: macOS reparents an orphan only to launchd,
   * so that parent started it, and a child of a process outside the sandbox is outside it too.
   */
  private frozen(
    before: ProcessSnapshot,
    members: readonly number[],
    after: ProcessSnapshot,
  ): boolean {
    // The PIDs handed out from just before the first listing to just after the second; a counter
    // that wrapped between them leaves nothing provable this round.
    if (after.lastPid <= before.firstPid) return false;
    const reissued = (pid: number): boolean => pid > before.firstPid && pid <= after.lastPid;
    const memberSet = new Set(members);
    const still = new Set(after.rows.map(identity));
    const foreignParents = new Set(
      after.rows.filter((row) => !memberSet.has(row.pid)).map((row) => row.pid),
    );
    const notBefore = this.options.startedAtMs - START_RESOLUTION_MS;
    return before.rows.every((row) => {
      if (stopped(row) || ended(row)) return true;
      if (memberSet.has(row.pid)) return false;
      if (!reissued(row.pid) && still.has(identity(row))) return true;
      const started = Date.parse(row.started);
      if (Number.isFinite(started) && started < notBefore) return true;
      return row.ppid !== LAUNCHD_PID && !reissued(row.ppid) && foreignParents.has(row.ppid);
    });
  }

  /** Kills the frozen members through the member until an answer names none. */
  private async end(
    membership: SandboxMembership,
    frozen: readonly number[],
  ): Promise<DescendantSweep> {
    let left = frozen;
    for (let check = 0; check < END_CHECKS && left.length > 0; check += 1) {
      for (const pid of left) this.counters.signalled.add(pid);
      await membership.signal(left, "kill");
      await delay(this.options.settleMs ?? SETTLE_MS);
      left = await this.members(membership, (await this.options.list()).rows);
    }
    if (left.length > 0) return this.result("survivors", left.length);
    return this.result(this.counters.signalled.size > 0 ? "reaped" : "clean", 0);
  }

  private result(outcome: DescendantSweepOutcome, survivorCount: number): DescendantSweep {
    const error = this.counters.failure;
    return {
      outcome,
      memberCount: this.counters.members.size,
      signalledCount: this.counters.signalled.size,
      survivorCount,
      roundCount: this.counters.rounds,
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
        memberCount: sweep.memberCount,
        signalledCount: sweep.signalledCount,
        survivorCount: sweep.survivorCount,
        roundCount: sweep.roundCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(sweep.error === undefined
          ? {}
          : { frames: keikoStackFrames(sweep.error), causeChain: causeChain(sweep.error) }),
      },
    ),
  );
}
