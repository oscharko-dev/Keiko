import { describe, expect, it, vi, type Mock } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  parseProcessListing,
  RuntimeDescendantTracker,
  sweepProvesEnd,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "./darwinRuntimeDescendants.js";
import {
  SandboxMembershipUnavailableError,
  type SandboxMembership,
} from "./darwinSandboxMembership.js";

const RUN_ID = "run-descendants";
const STARTED_AT_MS = Date.parse("Sun Oct 25 14:50:39 2026");
const BEFORE = "Sun Oct 25 14:40:00 2026";
const DURING = "Sun Oct 25 14:59:01 2026";

function row(pid: number, state = "S", started = DURING): ProcessIdentity {
  return { pid, ppid: 1, state, started };
}

// macOS hands out PIDs in sequence and wraps from its last PID to 100.
const LAST_PID = 99_998;
const FIRST_WRAPPED_PID = 100;

interface Host {
  readonly rows: ProcessIdentity[];
  readonly members: Set<number>;
  readonly signals: { readonly pid: number; readonly signal: "stop" | "kill" }[];
  readonly list: Mock<() => Promise<ProcessSnapshot>>;
  /** The last PID handed out. */
  counter: number;
  /** Runs when the member is asked, between the listing it was given and its answer. */
  onAnswer?: (() => void) | undefined;
}

/** The next PID, as the kernel hands it out to a new process. */
function spawn(table: Host): number {
  table.counter = table.counter >= LAST_PID ? FIRST_WRAPPED_PID : table.counter + 1;
  return table.counter;
}

/** A listing of `rows`, taken between the PIDs of a process started before it and one after. */
function snapshot(table: Host, rows: readonly ProcessIdentity[]): ProcessSnapshot {
  const firstPid = spawn(table);
  return { rows: rows.map((entry) => ({ ...entry })), firstPid, lastPid: spawn(table) };
}

// A process table and the kernel's answer for one sandbox instance: `members` are the PIDs its
// member may signal, and a signal from inside reaches only those, as the Seatbelt rule enforces.
function host(rows: ProcessIdentity[], members: readonly number[], counter = 10_000): Host {
  const table: Host = {
    rows,
    members: new Set(members),
    signals: [],
    counter,
    list: vi.fn(() => Promise.resolve(snapshot(table, table.rows))),
  };
  return table;
}

/** A process exits: the kernel reparents its children to launchd. */
function exit(table: Host, pid: number): void {
  table.rows.splice(
    table.rows.findIndex((entry) => entry.pid === pid),
    1,
  );
  table.members.delete(pid);
  for (const [index, entry] of table.rows.entries()) {
    if (entry.ppid === pid) table.rows[index] = { ...entry, ppid: 1 };
  }
}

/** A member forks a running child, which is a member too. */
function fork(table: Host, parent: number): number {
  const pid = spawn(table);
  table.rows.push({ pid, ppid: parent, state: "S", started: DURING });
  table.members.add(pid);
  return pid;
}

function kernel(table: Host, keep: (pid: number) => boolean = () => false): SandboxMembership {
  return {
    members: (pids): Promise<readonly number[]> => {
      table.onAnswer?.();
      const live = new Set(table.rows.map((entry) => entry.pid));
      return Promise.resolve(pids.filter((pid) => table.members.has(pid) && live.has(pid)));
    },
    signal: (pids, signal): Promise<void> => {
      for (const pid of pids) {
        if (!table.members.has(pid)) continue;
        table.signals.push({ pid, signal });
        const index = table.rows.findIndex((entry) => entry.pid === pid);
        const current = table.rows[index];
        if (current === undefined || keep(pid)) continue;
        if (signal === "kill") table.rows.splice(index, 1);
        else table.rows[index] = { ...current, state: "T" };
      }
      return Promise.resolve();
    },
    close: vi.fn(),
  };
}

function tracker(
  table: Host,
  membership: SandboxMembership | undefined,
  events: ServerLogEvent[] = [],
  clock?: () => number,
): RuntimeDescendantTracker {
  return new RuntimeDescendantTracker({
    runId: RUN_ID,
    activityLog: { write: (event) => void events.push(event) },
    list: table.list,
    ...(membership === undefined ? {} : { membership }),
    startedAtMs: STARTED_AT_MS,
    settleMs: 1,
    ...(clock === undefined ? {} : { clock }),
  });
}

/** Runs each step once, at the next answers the member gives. */
function answers(table: Host, steps: (() => void)[]): void {
  table.onAnswer = (): void => {
    steps.shift()?.();
  };
}

function line(event: ServerLogEvent | undefined): Readonly<Record<string, unknown>> {
  if (event === undefined) throw new TypeError("swept line missing");
  return expectActivityLogProof(
    "coding-runtime.descendants.swept.emitted-line",
    formatActivityLogProofLine(event),
  );
}

describe("macOS runtime descendants (#3899 AC2, #3901 AC3)", () => {
  it("parses a locale-independent listing with each process's state and ignores anything else", () => {
    expect(
      parseProcessListing(`  4711     1 Ss ${BEFORE}\n  12 4711 Z ${DURING}\ngarbage\n\n`),
    ).toEqual([
      { pid: 4711, ppid: 1, state: "Ss", started: BEFORE },
      { pid: 12, ppid: 4711, state: "Z", started: DURING },
    ]);
  });

  it("proves a clean end when no member is left, and signals nothing", async () => {
    const table = host([row(50), row(51, "S", BEFORE)], []);
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(table, kernel(table), sink.events).sweep();

    expect(sweep).toEqual({
      outcome: "clean",
      memberCount: 0,
      signalledCount: 0,
      survivorCount: 0,
      roundCount: 1,
    });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(table.signals).toEqual([]);
    expect(line(sink.events[0])).toMatchObject({ level: "info", outcome: "clean" });
  });

  // The members run, are stopped, are proven to be all there are, and only then are killed.
  it("freezes the run's members, proves none can appear, then ends them", async () => {
    const table = host([row(20), row(40), row(41), row(50)], [20, 40, 41]);
    const membership = kernel(table);
    const close = vi.spyOn(membership, "close");
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(table, membership, sink.events).sweep();

    expect(sweep).toEqual({
      outcome: "reaped",
      memberCount: 3,
      signalledCount: 3,
      survivorCount: 0,
      roundCount: 2,
    });
    expect(table.signals.map((entry) => entry.signal)).toEqual([
      "stop",
      "stop",
      "stop",
      "kill",
      "kill",
      "kill",
    ]);
    expect(table.rows.map((entry) => entry.pid)).toEqual([50]);
    expect(close).toHaveBeenCalledOnce();
    expect(line(sink.events[0])).toMatchObject({
      level: "info",
      op: "coding-runtime.descendants.swept",
      correlationId: RUN_ID,
      outcome: "reaped",
      memberCount: 3,
      roundCount: 2,
    });
    expect(sink.lines().join("\n")).not.toContain(DURING);
  });

  // PR #4064 review, finding 4371619368: a member forks and exits between the listing and the
  // answer; its child is absent from the listing and its own PID is no longer a member, so the
  // answer is empty although the run's child lives.
  it("never proves an end from a listing a member left before the answer", async () => {
    const table = host([row(70)], [70]);
    table.onAnswer = (): void => {
      table.onAnswer = undefined;
      table.rows.splice(0, 1, row(71));
      table.members.add(71);
    };
    const sweep = await tracker(table, kernel(table)).sweep();

    expect(sweep).toMatchObject({ outcome: "reaped", memberCount: 1, signalledCount: 1 });
    expect(sweep.roundCount).toBeGreaterThan(1);
    expect(table.rows).toEqual([]);
  });

  // PR #4064 review, finding 4371860462: a running member forks and exits before the answer, and a
  // process outside the sandbox gets its PID within the same `lstart` second. Its child then forks
  // and exits before the confirming answer too. The reused PID must never pass for the member.
  it.each([
    // macOS hands out PIDs in sequence, so reaching the member's PID again means wrapping round.
    { allocator: "a counter that wrapped", counter: 99_990, member: 120, skipTo: 119 },
    // A counter that handed the PID out between the listings, however it got there.
    { allocator: "a counter that passed the PID", counter: 60, member: 70, skipTo: 69 },
  ])("never takes a PID reused within one second for the member, with $allocator", async (spec) => {
    const table = host([row(spec.member)], [spec.member], spec.counter);
    let child = 0;
    let grandchild = 0;
    answers(table, [
      (): void => {
        child = fork(table, spec.member);
        exit(table, spec.member);
        table.counter = spec.skipTo;
        table.rows.push(row(spawn(table)));
      },
      (): void => {
        grandchild = fork(table, child);
        exit(table, child);
      },
    ]);
    const sweep = await tracker(table, kernel(table)).sweep();

    expect(table.rows.some((entry) => entry.pid === spec.member)).toBe(true);
    expect(sweep).toMatchObject({ outcome: "reaped", survivorCount: 0, signalledCount: 1 });
    expect(sweep.roundCount).toBeGreaterThan(1);
    expect(table.signals).toContainEqual({ pid: grandchild, signal: "kill" });
    expect(table.rows.map((entry) => entry.pid)).toEqual([spec.member]);
  });

  // The same schedule beside a frozen member, from a listing whose counter does not show the reuse:
  // the second answer names the child, which the first did not, so the round proves nothing and the
  // child is frozen before anything is killed.
  it("confirms a frozen run with one more answer and freezes a member only it names", async () => {
    const table = host([row(20, "T"), row(70)], [20, 70]);
    let child = 0;
    answers(table, [
      (): void => {
        child = fork(table, 70);
        exit(table, 70);
        table.rows.push(row(70));
      },
    ]);
    const sweep = await tracker(table, kernel(table)).sweep();

    expect(sweep).toMatchObject({ outcome: "reaped", survivorCount: 0, signalledCount: 2 });
    expect(sweep.roundCount).toBeGreaterThan(1);
    expect(table.signals.map((entry) => `${entry.signal}:${String(entry.pid)}`)).toEqual([
      "stop:20",
      `stop:${String(child)}`,
      "kill:20",
      `kill:${String(child)}`,
    ]);
    expect(table.rows.map((entry) => entry.pid)).toEqual([70]);
  });

  // A round slow enough for the counter to go all the way round could look unwrapped.
  it("proves nothing from a round that took longer than a PID turn could", async () => {
    const table = host([], []);
    let now = 0;
    const clock = (): number => (now += 501);
    const sweep = await tracker(table, kernel(table), [], clock).sweep();

    expect(sweep).toMatchObject({ outcome: "unproven", roundCount: 20 });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  // PR #4064 review, finding 4371619380: without the member, a host signal to a recorded PID could
  // reach a process that reused it. Nothing is signalled, and the end stays unproven.
  it("signals nothing and proves nothing without the member's answer", async () => {
    const table = host([row(80), row(81)], [80]);
    const signal = vi.fn(() => Promise.resolve());
    const membership: SandboxMembership = {
      members: () => Promise.reject(new SandboxMembershipUnavailableError("ended")),
      signal,
      close: vi.fn(),
    };
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(table, membership, sink.events).sweep();

    expect(sweep).toMatchObject({ outcome: "membership-unavailable", signalledCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(signal).not.toHaveBeenCalled();
    expect(table.rows.map((entry) => entry.pid)).toEqual([80, 81]);
    expect(line(sink.events[0])).toMatchObject({
      level: "warn",
      outcome: "membership-unavailable",
      frames: expect.any(Array) as unknown,
    });
  });

  it("reports a run without a member as unproven and signals nothing", async () => {
    const table = host([row(80)], []);
    const sweep = await tracker(table, undefined).sweep();

    expect(sweep).toMatchObject({ outcome: "unproven", signalledCount: 0, roundCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(table.list).not.toHaveBeenCalled();
  });

  it("stays unproven while running processes keep ending in every round", async () => {
    let next = 1_000;
    const table = host([], []);
    // A process of the host's that ends between every two listings of a round.
    table.list.mockImplementation(() => Promise.resolve(snapshot(table, [row((next += 1))])));
    const sweep = await tracker(table, kernel(table)).sweep();

    expect(sweep).toMatchObject({ outcome: "unproven", roundCount: 20, signalledCount: 0 });
  });

  // A child of a live process outside the sandbox is outside it too (macOS reparents an orphan only
  // to launchd), so the host's own short-lived work does not keep the run unproven.
  it("does not count a child of a live foreign process as a possible member", async () => {
    let next = 3_000;
    const table = host([], []);
    table.list.mockImplementation(() =>
      Promise.resolve(snapshot(table, [row(60), { ...row((next += 1)), ppid: 60 }])),
    );

    await expect(tracker(table, kernel(table)).sweep()).resolves.toMatchObject({
      outcome: "clean",
      roundCount: 1,
    });
  });

  it("counts a vanished child of a member, or of a parent that is gone, as a possible member", async () => {
    for (const parent of [70, 71]) {
      let next = 4_000;
      const table = host([row(70, "T")], [70]);
      // 70 is a frozen member; 71 has gone. A running child of either vanishes in every round.
      table.list.mockImplementation(() =>
        Promise.resolve(snapshot(table, [...table.rows, { ...row((next += 1)), ppid: parent }])),
      );
      await expect(tracker(table, kernel(table)).sweep(), String(parent)).resolves.toMatchObject({
        outcome: "unproven",
      });
    }
  });

  it("does not count a process that ran before the run as a possible member", async () => {
    let next = 2_000;
    const table = host([], []);
    table.list.mockImplementation(() =>
      Promise.resolve(snapshot(table, [row((next += 1), "S", BEFORE)])),
    );

    await expect(tracker(table, kernel(table)).sweep()).resolves.toMatchObject({
      outcome: "clean",
      roundCount: 1,
    });
  });

  it("never asks about a zombie, which has already ended", async () => {
    const table = host([row(90, "Z"), row(91)], [90, 91]);
    const asked: number[][] = [];
    const membership = kernel(table);
    const members = membership.members.bind(membership);
    membership.members = (pids): Promise<readonly number[]> => {
      asked.push([...pids]);
      return members(pids);
    };

    await expect(tracker(table, membership).sweep()).resolves.toMatchObject({
      outcome: "reaped",
      memberCount: 1,
    });
    expect(asked.every((pids) => !pids.includes(90))).toBe(true);
  });

  it("reports a member it cannot end", async () => {
    const table = host([row(20)], [20]);
    const events: ServerLogEvent[] = [];
    const sweep = await tracker(
      table,
      kernel(table, (pid) => pid === 20),
      events,
    ).sweep();

    // The member never stops either, so the run is never proven frozen.
    expect(sweep).toMatchObject({ outcome: "unproven", survivorCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(events[0]).toMatchObject({ level: "warn", errorKind: "internal" });
  });

  it("reports survivors when a frozen member outlives every kill", async () => {
    const table = host([row(20, "T")], [20]);
    const sweep = await tracker(
      table,
      kernel(table, (pid) => pid === 20),
    ).sweep();

    expect(sweep).toMatchObject({ outcome: "survivors", survivorCount: 1, signalledCount: 1 });
  });

  it("reports a listing it could not take instead of a clean end, with its error evidence", async () => {
    const table = host([row(20)], [20]);
    table.list.mockRejectedValue(
      new TypeError("ps-unavailable", { cause: new RangeError("ps-output-too-large") }),
    );
    const sink = createBufferedServerLogSink();

    await expect(tracker(table, kernel(table), sink.events).sweep()).resolves.toMatchObject({
      outcome: "listing-failed",
    });
    expect(line(sink.events[0])).toMatchObject({
      level: "warn",
      outcome: "listing-failed",
      causeChain: ["RangeError"],
      frames: expect.any(Array) as unknown,
    });
    expect(sink.lines().join("\n")).not.toMatch(/ps-unavailable|ps-output-too-large/u);
  });

  it("sweeps once", async () => {
    const table = host([], []);
    const descendants = tracker(table, kernel(table));
    const first = descendants.sweep();

    expect(descendants.sweep()).toBe(first);
    await expect(first).resolves.toMatchObject({ outcome: "clean" });
  });
});
