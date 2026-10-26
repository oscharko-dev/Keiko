import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ProcessTable, ProcessTableReader } from "./darwinProcessTable.js";
import type { SandboxMembership, SandboxMemberSelf } from "./darwinSandboxMembership.js";

// #3899 AC2 / #3901 AC3: on macOS the runtime's shell children leave its process group (the
// original service starts each in its own), and a command can detach a process itself (`cmd &`,
// `nohup`, `setsid`); launchd adopts it at once. A group kill therefore ends only the service. Once
// the service has exited and been reaped, the sweep ends every process of the run's sandbox
// instance through the run's member (darwinSandboxMembership.ts), which asks the kernel and signals
// from inside the instance: ownership is the kernel's, and a process of anyone else is never
// signalled.
//
// The end is proven by kernel facts only (PR #4064 review). First the member's broadcast check:
// when the kernel reports that its `kill(-1, 0)` reached nothing, no process of the instance
// besides the member exists, and none can appear, because only a process of the instance can start
// another and the member forks nothing. XNU counts a zombie of the same user in that check without
// the sandbox's test, so "occupied" can be an unrelated zombie anywhere on the host. Then the sweep
// proves the end by identity instead (`identityProofCount`), with the kernel's per-boot process
// identity `p_uniqueid`, assigned at fork from a counter that only grows, kept across exec and never
// handed out again (darwinProcessTable.ts):
// 1. It reads the host's process table: every listed process with its identity and the identity of
//    the process that forked it.
// 2. The member answers, for each live process of that table, whether it belongs to the instance.
//    Any member proves the run is not over.
// 3. It reads the table again. A process asked about while it was alive and still alive with the
//    same identity was answered while alive: it is no member, and never was one, since a process
//    cannot enter an instance it was not started in.
// The end is proven when the first table names no PID that ended, or that the kernel refused to
// identify, before it could be read, and every process in it (zombies included) is such a
// non-member, was forked by one, or was forked before the run's root. Every process of the run
// descends from its root, so its identity is larger than the root's; the root's identity is the one
// that forked the member, taken only while the member still names the root's PID as its parent.
// Then no member was alive when the first table was listed: a member alive then was either answered
// as one, or ended before an answer, and so neither stayed alive nor had a non-member parent (its
// parent was a member). Without a member alive, none can appear afterwards. The run's root, the only
// member a non-member forked, has exited and been reaped before the sweep starts.
//
// While a member remains, the member sends SIGKILL to all of them in one broadcast and the sweep
// asks again; a process forked during a broadcast is reached by the next one. A process that
// outlives every broadcast (`survivors`), a table the host cannot read (`listing-failed`), a host
// whose processes keep ending during the proof (`unproven`), a run without a member (`unproven`,
// the gateway profile has no shell) and a member that no longer answers (`membership-unavailable`)
// leave the end unproven. None of them is ever reported as a clean end, and without the member
// nothing is signalled at all.

export type DescendantSweepOutcome =
  "clean" | "reaped" | "survivors" | "unproven" | "listing-failed" | "membership-unavailable";

export interface DescendantSweep {
  readonly outcome: DescendantSweepOutcome;
  /** SIGKILL broadcasts the member sent to the run's remaining processes. */
  readonly roundCount: number;
  /** Times the member asked the kernel whether any process of the instance remains. */
  readonly checkCount: number;
  /** Identity proofs the sweep needed because the kernel's check also counts zombies. */
  readonly identityProofCount: number;
  /** Distinct processes of the run the member identified during the identity proofs. */
  readonly memberCount: number;
  /** The failure that ended the proof, for `listing-failed` and `membership-unavailable`. */
  readonly error?: unknown;
}

export interface DescendantTrackerOptions {
  readonly runId: string;
  readonly activityLog: ServerLogSink;
  /** The kernel's answer for the run's sandbox instance; absent when the run has no member. */
  readonly membership?: SandboxMembership | undefined;
  /** The host's process table with kernel identities, read outside every sandbox. */
  readonly readTable: ProcessTableReader;
  /** The PID of the run's root: the sandboxed process that becomes the service. */
  readonly rootPid: number;
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
      values: [
        "clean",
        "reaped",
        "survivors",
        "unproven",
        "listing-failed",
        "membership-unavailable",
      ],
    },
    roundCount: { type: "integer", dataClass: "count", required: true },
    checkCount: { type: "integer", dataClass: "count", required: true },
    identityProofCount: { type: "integer", dataClass: "count", required: true },
    memberCount: { type: "integer", dataClass: "count", required: true },
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

/**
 * Whether two process tables, read before and after the member answered that none of the first
 * table's live processes belongs to the run, prove that no process of the run was alive when the
 * first table was listed. `selfId` is the member's own identity; `rootId` the identity of the run's
 * root, when it is known, below which no process of the run can be.
 */
export function tablesProveNoMember(
  before: ProcessTable,
  after: ProcessTable,
  selfId: string,
  rootId: string | undefined,
): boolean {
  if (before.goneCount > 0 || before.unidentifiedCount > 0) return false;
  const alive = new Set(after.records.filter((row) => !row.zombie).map((row) => row.uniqueId));
  // Asked about while alive, answered as no member, and alive with the same identity afterwards.
  const nonMembers = new Set(
    before.records
      .filter((row) => !row.zombie && row.uniqueId !== selfId && alive.has(row.uniqueId))
      .map((row) => row.uniqueId),
  );
  const root = rootId === undefined ? undefined : BigInt(rootId);
  return before.records.every(
    (row) =>
      row.uniqueId === selfId ||
      nonMembers.has(row.uniqueId) ||
      nonMembers.has(row.parentUniqueId) ||
      (root !== undefined && BigInt(row.uniqueId) < root),
  );
}

type IdentityProof = "no-member" | "members" | "uncertain";

interface SweepCounters {
  rounds: number;
  checks: number;
  proofs: number;
  readonly members: Set<string>;
  /** The failure that ended the proof; the sweep's line carries its frames and cause chain. */
  failure?: unknown;
}

// The first failure that ended the proof is the one the sweep's line reports.
function recordSweepFailure(counters: SweepCounters, error: unknown): void {
  counters.failure ??= error;
}

class ProcessTableUnavailableError extends Error {
  public constructor(cause: unknown) {
    super("darwin-process-table-unavailable", { cause });
    this.name = "ProcessTableUnavailableError";
  }
}

export class RuntimeDescendantTracker {
  private readonly counters: SweepCounters = {
    rounds: 0,
    checks: 0,
    proofs: 0,
    members: new Set(),
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
    // Without the member nothing is signalled: only the kernel's answer may reach a process.
    if (membership === undefined) return this.result("unproven");
    try {
      return await this.endAll(membership);
    } catch (error) {
      // A table the host cannot read, or a member that no longer answers, proves nothing; the line
      // carries the failure's evidence.
      recordSweepFailure(this.counters, error);
      return this.result(
        error instanceof ProcessTableUnavailableError ? "listing-failed" : "membership-unavailable",
      );
    }
  }

  /** Broadcasts SIGKILL through the member until the kernel's facts prove that none remains. */
  private async endAll(membership: SandboxMembership): Promise<DescendantSweep> {
    const self = await membership.self();
    for (;;) {
      const proof = await this.prove(membership, self);
      if (proof === "no-member") return this.result(this.ended() ? "reaped" : "clean");
      if (this.counters.rounds >= KILL_ROUNDS)
        return this.result(proof === "members" ? "survivors" : "unproven");
      const settleMs = this.options.settleMs ?? SETTLE_MS;
      await membership.killAll(); // NOSONAR typescript:S9382 -- each round acts on the previous round's kernel proof
      await delay(Math.min(MAX_SETTLE_MS, settleMs * 2 ** this.counters.rounds)); // NOSONAR typescript:S9382 -- the backoff before the next proof
      this.counters.rounds += 1;
    }
  }

  private ended(): boolean {
    return this.counters.rounds > 0 || this.counters.members.size > 0;
  }

  // The broadcast check first; an "occupied" answer, which a zombie can cause, needs the identities.
  private async prove(
    membership: SandboxMembership,
    self: SandboxMemberSelf,
  ): Promise<IdentityProof> {
    this.counters.checks += 1;
    if (!(await membership.occupied())) return "no-member";
    return this.proveByIdentity(membership, self);
  }

  private async proveByIdentity(
    membership: SandboxMembership,
    self: SandboxMemberSelf,
  ): Promise<IdentityProof> {
    this.counters.proofs += 1;
    const before = await this.table();
    const live = before.records.filter((row) => !row.zombie && row.uniqueId !== self.uniqueId);
    const members = (await membership.members(live.map((row) => row.pid))).filter(
      (member) => member.uniqueId !== self.uniqueId,
    );
    for (const member of members) this.counters.members.add(member.uniqueId);
    if (members.length > 0) return "members";
    // A member reparented before it announced itself no longer names the root that forked it.
    const rootId = self.parentPid === this.options.rootPid ? self.parentUniqueId : undefined;
    return tablesProveNoMember(before, await this.table(), self.uniqueId, rootId)
      ? "no-member"
      : "uncertain";
  }

  private async table(): Promise<ProcessTable> {
    try {
      return await this.options.readTable();
    } catch (error) {
      throw new ProcessTableUnavailableError(error);
    }
  }

  private result(outcome: DescendantSweepOutcome): DescendantSweep {
    const error = this.counters.failure;
    return {
      outcome,
      roundCount: this.counters.rounds,
      checkCount: this.counters.checks,
      identityProofCount: this.counters.proofs,
      memberCount: this.counters.members.size,
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
        identityProofCount: sweep.identityProofCount,
        memberCount: sweep.memberCount,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(sweep.error === undefined
          ? {}
          : { frames: keikoStackFrames(sweep.error), causeChain: causeChain(sweep.error) }),
      },
    ),
  );
}
