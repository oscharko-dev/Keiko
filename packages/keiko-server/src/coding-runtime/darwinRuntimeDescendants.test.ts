import { describe, expect, it, vi } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { ProcessRecord, ProcessTable } from "./darwinProcessTable.js";
import {
  RuntimeDescendantTracker,
  sweepProvesEnd,
  tablesProveNoMember,
} from "./darwinRuntimeDescendants.js";
import {
  SandboxMembershipUnavailableError,
  type SandboxMember,
  type SandboxMembership,
  type SandboxMemberSelf,
} from "./darwinSandboxMembership.js";

const RUN_ID = "run-descendants";
// The run's root (identity 400) forked the member (500); every process of the run is forked later.
const ROOT_PID = 40;
const ROOT_ID = "400";
const SELF: SandboxMemberSelf = {
  pid: 50,
  uniqueId: "500",
  parentPid: ROOT_PID,
  parentUniqueId: ROOT_ID,
};
const HOST: ProcessRecord = { pid: 10, zombie: false, uniqueId: "100", parentUniqueId: "1" };

// A process forked after the run's root: its identity is larger than the root's.
function process(
  pid: number,
  parentUniqueId: string,
  extra: Partial<ProcessRecord> = {},
): ProcessRecord {
  return { pid, zombie: false, uniqueId: String(pid * 10), parentUniqueId, ...extra };
}

// A host as the kernel answers it: every process with its identity, the ones that belong to the
// run's sandbox instance, those a SIGKILL cannot end, and the PIDs that end while a table is read.
interface Host {
  readonly processes: ProcessRecord[];
  readonly members: Set<string>;
  readonly unkillable: Set<string>;
  broadcasts: number;
  /** PIDs the next table lists but finds gone before reading them. */
  goneOnRead: number;
  /** Runs when the member is asked about identities, after the first table was read. */
  onMembers?: (() => void) | undefined;
}

function host(processes: ProcessRecord[], members: readonly string[] = []): Host {
  return {
    processes: [
      { ...HOST },
      { pid: SELF.pid, zombie: false, uniqueId: SELF.uniqueId, parentUniqueId: ROOT_ID },
      ...processes,
    ],
    members: new Set(members),
    unkillable: new Set(),
    broadcasts: 0,
    goneOnRead: 0,
  };
}

function table(state: Host): ProcessTable {
  const goneCount = state.goneOnRead;
  state.goneOnRead = 0;
  return {
    records: state.processes.map((row) => ({ ...row })),
    goneCount,
    foreignUserCount: 3,
    unidentifiedCount: 0,
  };
}

// The member: XNU's broadcast check also counts any zombie of the same user.
function member(state: Host): SandboxMembership {
  const liveMember = (row: ProcessRecord): boolean =>
    !row.zombie && state.members.has(row.uniqueId);
  return {
    self: () => Promise.resolve(SELF),
    occupied: () => Promise.resolve(state.processes.some((row) => liveMember(row) || row.zombie)),
    members: (pids): Promise<readonly SandboxMember[]> => {
      state.onMembers?.();
      return Promise.resolve(
        state.processes
          .filter((row) => pids.includes(row.pid) && liveMember(row))
          .map((row) => ({ pid: row.pid, uniqueId: row.uniqueId })),
      );
    },
    killAll: (): Promise<void> => {
      state.broadcasts += 1;
      // A killed member's parent is gone too, so launchd reaps it at once.
      const survivors = state.processes.filter(
        (row) => !liveMember(row) || state.unkillable.has(row.uniqueId),
      );
      state.processes.splice(0, state.processes.length, ...survivors);
      return Promise.resolve();
    },
    close: vi.fn(),
  };
}

function tracker(
  state: Host,
  membership: SandboxMembership = member(state),
  events: ServerLogEvent[] = [],
): RuntimeDescendantTracker {
  return new RuntimeDescendantTracker({
    runId: RUN_ID,
    activityLog: { write: (event) => void events.push(event) },
    membership,
    readTable: (): Promise<ProcessTable> => Promise.resolve(table(state)),
    rootPid: ROOT_PID,
    settleMs: 0,
  });
}

function line(event: ServerLogEvent | undefined): Readonly<Record<string, unknown>> {
  if (event === undefined) throw new TypeError("swept line missing");
  return expectActivityLogProof(
    "coding-runtime.descendants.swept.emitted-line",
    formatActivityLogProofLine(event),
  );
}

describe("macOS runtime descendants (#3899 AC2, #3901 AC3)", () => {
  it("proves a clean end when the kernel's broadcast check reaches nothing, and signals nothing", async () => {
    const state = host([]);
    const membership = member(state);
    const close = vi.spyOn(membership, "close");
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(state, membership, sink.events).sweep();

    expect(sweep).toEqual({
      outcome: "clean",
      roundCount: 0,
      checkCount: 1,
      identityProofCount: 0,
      memberCount: 0,
    });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(state.broadcasts).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(line(sink.events[0])).toMatchObject({
      level: "info",
      op: "coding-runtime.descendants.swept",
      correlationId: RUN_ID,
      outcome: "clean",
      identityProofCount: 0,
    });
  });

  // PR #4064 review (4372402175, 4373090489): XNU counts a zombie of the same user in the broadcast
  // check without the sandbox's test. An unrelated zombie, held by a live parent outside the run,
  // makes the check "occupied" for good; the identities prove that it is not the run's.
  it("proves a clean end despite an unrelated zombie the broadcast check counts", async () => {
    const parent = process(70, HOST.uniqueId);
    const state = host([parent, process(71, parent.uniqueId, { zombie: true })]);
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(state, member(state), sink.events).sweep();

    expect(sweep).toEqual({
      outcome: "clean",
      roundCount: 0,
      checkCount: 1,
      identityProofCount: 1,
      memberCount: 0,
    });
    expect(state.broadcasts).toBe(0);
    expect(line(sink.events[0])).toMatchObject({ outcome: "clean", identityProofCount: 1 });
  });

  it("ends the run's processes despite the zombie, and proves it by identity", async () => {
    const parent = process(70, HOST.uniqueId);
    const job = process(80, ROOT_ID);
    const detached = process(81, job.uniqueId);
    const state = host(
      [parent, process(71, parent.uniqueId, { zombie: true }), job, detached],
      [job.uniqueId, detached.uniqueId],
    );
    const sweep = await tracker(state).sweep();

    expect(sweep).toMatchObject({ outcome: "reaped", roundCount: 1, memberCount: 2 });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(state.processes.map((row) => row.pid)).toEqual([HOST.pid, SELF.pid, 70, 71]);
  });

  // A member ends between the first table and the member's answer, after forking a child the table
  // cannot name. It was alive, is no longer, and its parent was a member: nothing is proven.
  it("proves nothing from a table a member left before the answer", async () => {
    const member80 = process(80, ROOT_ID);
    const state = host([member80], [member80.uniqueId]);
    state.onMembers = (): void => {
      state.onMembers = undefined;
      state.processes.splice(state.processes.indexOf(member80), 1);
      const child = process(82, member80.uniqueId);
      state.processes.push(child);
      state.members.add(child.uniqueId);
    };
    const sweep = await tracker(state).sweep();

    // The child was never named, yet the broadcast that followed ended it.
    expect(sweep).toMatchObject({ outcome: "reaped", roundCount: 1, memberCount: 0 });
    expect(state.processes.map((row) => row.pid)).toEqual([HOST.pid, SELF.pid]);
  });

  // A PID that ended between the listing and its read may have been a member that forked: that
  // round proves nothing, and the sweep broadcasts and asks again.
  it("proves nothing from a table that lost a PID before reading it", async () => {
    const state = host([process(95, HOST.uniqueId, { zombie: true })]);
    state.goneOnRead = 1;
    const sweep = await tracker(state).sweep();

    expect(sweep).toMatchObject({
      outcome: "reaped",
      roundCount: 1,
      identityProofCount: 2,
      memberCount: 0,
    });
  });

  it("does not take a zombie whose parent has gone for a host process", () => {
    const records = [HOST, process(90, "999", { zombie: true })];
    const tableOf = (rows: ProcessRecord[]): ProcessTable => ({
      records: rows,
      goneCount: 0,
      foreignUserCount: 0,
      unidentifiedCount: 0,
    });
    expect(tablesProveNoMember(tableOf(records), tableOf([HOST]), SELF.uniqueId, ROOT_ID)).toBe(
      false,
    );
  });

  it("accepts a host process forked before the run's root, or one a non-member forked", () => {
    const before: ProcessTable = {
      records: [
        HOST,
        process(30, "1", { zombie: true }),
        process(61, HOST.uniqueId),
        process(62, HOST.uniqueId, { zombie: true }),
      ],
      goneCount: 0,
      foreignUserCount: 4,
      unidentifiedCount: 0,
    };
    const after: ProcessTable = { ...before, records: [HOST] };

    expect(tablesProveNoMember(before, after, SELF.uniqueId, ROOT_ID)).toBe(true);
    // A PID that ended before it was read, or a process the kernel refused to identify although it
    // is no other user's, may have been the run's.
    expect(tablesProveNoMember({ ...before, goneCount: 1 }, after, SELF.uniqueId, ROOT_ID)).toBe(
      false,
    );
    expect(
      tablesProveNoMember({ ...before, unidentifiedCount: 1 }, after, SELF.uniqueId, ROOT_ID),
    ).toBe(false);
    // Without the root's identity, age proves nothing.
    expect(tablesProveNoMember(before, after, SELF.uniqueId, undefined)).toBe(false);
    // The run's root itself, and a child forked by a process that has ended, may be the run's.
    for (const row of [process(40, "1", { zombie: true }), process(63, "777")])
      expect(
        tablesProveNoMember(
          { ...before, records: [...before.records, row] },
          after,
          SELF.uniqueId,
          ROOT_ID,
        ),
      ).toBe(false);
  });

  // A member reparented before it announced itself names launchd as its parent: the identity that
  // forked it is then no proof of the run's root, and age proves nothing.
  it("does not bound the run by a forker it cannot tie to the run's root", async () => {
    const state = host([process(30, "1", { zombie: true })]);
    const membership = member(state);
    membership.self = (): Promise<SandboxMemberSelf> => Promise.resolve({ ...SELF, parentPid: 1 });
    const sweep = await tracker(state, membership).sweep();

    expect(sweep).toMatchObject({ outcome: "unproven", roundCount: 50, memberCount: 0 });
    // Tied to the root, the same zombie is older than the run.
    const tied = host([process(30, "1", { zombie: true })]);
    await expect(tracker(tied).sweep()).resolves.toMatchObject({ outcome: "clean" });
  });

  it("stays unproven while a host's processes keep ending during every proof", async () => {
    const state = host([process(95, HOST.uniqueId, { zombie: true })]);
    const readTable = (): Promise<ProcessTable> =>
      Promise.resolve({ ...table(state), goneCount: 1 });
    const sweep = await new RuntimeDescendantTracker({
      runId: RUN_ID,
      activityLog: { write: vi.fn() },
      membership: member(state),
      readTable,
      rootPid: ROOT_PID,
      settleMs: 0,
    }).sweep();

    expect(sweep).toMatchObject({ outcome: "unproven", roundCount: 50, memberCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  it("never proves an end while a process outlives every broadcast", async () => {
    const stubborn = process(80, ROOT_ID);
    const state = host([stubborn], [stubborn.uniqueId]);
    state.unkillable.add(stubborn.uniqueId);
    const events: ServerLogEvent[] = [];
    const sweep = await tracker(state, member(state), events).sweep();

    expect(sweep).toMatchObject({ outcome: "survivors", roundCount: 50, memberCount: 1 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(line(events[0])).toMatchObject({ level: "warn", outcome: "survivors" });
    expect(events[0]).toMatchObject({ errorKind: "internal" });
  });

  it("reports a table the host cannot read, with its error evidence", async () => {
    const state = host([process(95, HOST.uniqueId, { zombie: true })]);
    const sink = createBufferedServerLogSink();
    const sweep = await new RuntimeDescendantTracker({
      runId: RUN_ID,
      activityLog: sink,
      membership: member(state),
      readTable: (): Promise<ProcessTable> => Promise.reject(new RangeError("table-too-large")),
      rootPid: ROOT_PID,
      settleMs: 0,
    }).sweep();

    expect(sweep).toMatchObject({ outcome: "listing-failed", roundCount: 0 });
    expect(line(sink.events[0])).toMatchObject({
      level: "warn",
      outcome: "listing-failed",
      causeChain: ["RangeError"],
      frames: expect.any(Array) as unknown,
    });
    expect(sink.lines().join("\n")).not.toContain("table-too-large");
  });

  // PR #4064 review (4371619380): without the member's answer a host signal could reach anything.
  it("signals nothing and proves nothing when the member no longer answers", async () => {
    const killAll = vi.fn(() => Promise.resolve());
    const membership: SandboxMembership = {
      self: () => Promise.resolve(SELF),
      occupied: () => Promise.reject(new SandboxMembershipUnavailableError("ended")),
      members: () => Promise.resolve([]),
      killAll,
      close: vi.fn(),
    };
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(host([]), membership, sink.events).sweep();

    expect(sweep).toMatchObject({ outcome: "membership-unavailable", roundCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(killAll).not.toHaveBeenCalled();
    expect(line(sink.events[0])).toMatchObject({
      level: "warn",
      outcome: "membership-unavailable",
      frames: expect.any(Array) as unknown,
    });
    expect(sink.lines().join("\n")).not.toContain("sandbox-membership-ended");
  });

  it("reports a run without a member as unproven and signals nothing", async () => {
    const state = host([process(80, ROOT_ID)], ["800"]);
    const sweep = await new RuntimeDescendantTracker({
      runId: RUN_ID,
      activityLog: { write: vi.fn() },
      readTable: (): Promise<ProcessTable> => Promise.resolve(table(state)),
      rootPid: ROOT_PID,
    }).sweep();

    expect(sweep).toEqual({
      outcome: "unproven",
      roundCount: 0,
      checkCount: 0,
      identityProofCount: 0,
      memberCount: 0,
    });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  it("sweeps once", async () => {
    const job = process(80, ROOT_ID);
    const state = host([job], [job.uniqueId]);
    const descendants = tracker(state);
    const first = descendants.sweep();

    expect(descendants.sweep()).toBe(first);
    await expect(first).resolves.toMatchObject({ outcome: "reaped" });
    expect(state.broadcasts).toBe(1);
  });
});
