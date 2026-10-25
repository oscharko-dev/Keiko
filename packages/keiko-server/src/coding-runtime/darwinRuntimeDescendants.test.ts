import { describe, expect, it, vi, type Mock } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  descendantsOf,
  parseProcessListing,
  RuntimeDescendantTracker,
  sweepProvesEnd,
  type ProcessIdentity,
} from "./darwinRuntimeDescendants.js";
import {
  SandboxMembershipUnavailableError,
  type SandboxMembership,
} from "./darwinSandboxMembership.js";

const ROOT = 4_711;
const RUN_ID = "run-descendants";
const STARTED = "Sun Oct 25 14:50:39 2026";
const LATER = "Sun Oct 25 14:59:01 2026";

function row(pid: number, ppid: number, started = STARTED, state = "S"): ProcessIdentity {
  return { pid, ppid, state, started };
}

interface HostTable {
  readonly rows: ProcessIdentity[];
  readonly signals: { readonly pid: number; readonly signal: NodeJS.Signals }[];
  readonly list: Mock<() => Promise<readonly ProcessIdentity[]>>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
}

// A process table the test owns: a signalled process leaves it unless `keep` says otherwise.
function hostTable(
  rows: ProcessIdentity[],
  keep: (pid: number) => boolean = () => false,
): HostTable {
  const signals: { readonly pid: number; readonly signal: NodeJS.Signals }[] = [];
  return {
    rows,
    signals,
    list: vi.fn(() => Promise.resolve([...rows])),
    signal: (pid: number, signal: NodeJS.Signals): void => {
      signals.push({ pid, signal });
      if (keep(pid)) return;
      const index = rows.findIndex((entry) => entry.pid === pid);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

interface Kernel extends SandboxMembership {
  readonly asked: (readonly number[])[];
  readonly closed: () => boolean;
}

// The kernel's answer for one sandbox instance: `members` are the PIDs its member may signal. A
// signal from inside reaches only those, exactly as the Seatbelt rule enforces.
function kernel(table: HostTable, members: ReadonlySet<number>): Kernel {
  const asked: (readonly number[])[] = [];
  let closed = false;
  return {
    asked,
    closed: (): boolean => closed,
    members: (pids): Promise<readonly number[]> => {
      asked.push(pids);
      return Promise.resolve(pids.filter((pid) => members.has(pid)));
    },
    signal: (pids, signal): Promise<void> => {
      for (const pid of pids)
        if (members.has(pid)) table.signal(pid, signal === "term" ? "SIGTERM" : "SIGKILL");
      return Promise.resolve();
    },
    close: (): void => {
      closed = true;
    },
  };
}

function tracker(
  table: HostTable,
  membership?: SandboxMembership,
  events: ServerLogEvent[] = [],
): RuntimeDescendantTracker {
  return new RuntimeDescendantTracker({
    rootPid: ROOT,
    runId: RUN_ID,
    activityLog: { write: (event) => void events.push(event) },
    list: table.list,
    ...(membership === undefined ? {} : { membership }),
    signal: table.signal,
    sampleIntervalMs: 2,
    settleMs: 1,
  });
}

async function sampled(table: HostTable, count = 2): Promise<void> {
  await vi.waitFor(() => {
    expect(table.list.mock.calls.length).toBeGreaterThanOrEqual(count);
  });
}

describe("macOS runtime descendants (#3899 AC2, #3901 AC3)", () => {
  it("parses a locale-independent listing with each process's state and ignores anything else", () => {
    expect(
      parseProcessListing(
        `  ${String(ROOT)}     1 Ss ${STARTED}\n  12 ${String(ROOT)} Z ${LATER}\ngarbage\n\n`,
      ),
    ).toEqual([row(ROOT, 1, STARTED, "Ss"), row(12, ROOT, LATER, "Z")]);
  });

  it("finds every descendant of the roots, roots excluded", () => {
    const rows = [row(ROOT, 1), row(20, ROOT), row(21, 20), row(22, 21), row(30, 1)];
    expect(descendantsOf(rows, new Set([ROOT])).map((entry) => entry.pid)).toEqual([20, 21, 22]);
  });

  // The kernel answers ownership: a child of the service, a process that left the tree with
  // `setsid` before any sample, and one that changed its directory all belong to the run.
  it("ends every member of the run's sandbox, however it left the tree, and proves the end", async () => {
    const table = hostTable([row(20, 1), row(40, 1, LATER), row(41, 1, LATER), row(50, 1, LATER)]);
    const membership = kernel(table, new Set([20, 40, 41]));
    const sink = createBufferedServerLogSink();
    const descendants = tracker(table, membership, sink.events);

    const sweep = await descendants.sweep();
    expect(sweep).toEqual({
      outcome: "reaped",
      trackedCount: 0,
      memberCount: 3,
      signalledCount: 3,
      survivorCount: 0,
      failedSampleCount: 0,
      refusedSignalCount: 0,
    });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(table.signals.map((entry) => entry.pid)).toEqual([20, 40, 41]);
    expect(table.rows.map((entry) => entry.pid)).toEqual([50]);
    expect(membership.closed()).toBe(true);
    expect(
      expectActivityLogProof(
        "coding-runtime.descendants.swept.emitted-line",
        formatActivityLogProofLine(sink.events[0] as ServerLogEvent),
      ),
    ).toMatchObject({
      level: "info",
      op: "coding-runtime.descendants.swept",
      correlationId: RUN_ID,
      outcome: "reaped",
      memberCount: 3,
      signalledCount: 3,
      survivorCount: 0,
    });
    expect(sink.lines().join("\n")).not.toContain(STARTED);
  });

  // PR #4064 review, finding 4371328652: a process the human started in the workspace after the
  // service, later adopted by launchd, was signalled by the former working-directory rule.
  it("never signals a process outside the run's sandbox, whatever its parent, directory or start", async () => {
    const table = hostTable([row(ROOT, 1), row(60, 1, LATER), row(61, 1, LATER)]);
    const descendants = tracker(table, kernel(table, new Set()));
    descendants.start();
    await sampled(table);
    table.rows.shift();

    await expect(descendants.sweep()).resolves.toMatchObject({
      outcome: "clean",
      memberCount: 0,
      signalledCount: 0,
    });
    expect(table.signals).toEqual([]);
  });

  // PR #4064 review, finding 4371328653: a descendant that left the tree before the first sample
  // left nothing to sweep, and the sweep reported a clean end.
  it("finds a member no sample ever saw", async () => {
    const table = hostTable([row(70, 1, LATER)]);
    const membership = kernel(table, new Set([70]));
    const descendants = tracker(table, membership);

    await expect(descendants.sweep()).resolves.toMatchObject({
      outcome: "reaped",
      trackedCount: 0,
      memberCount: 1,
    });
    expect(table.rows).toEqual([]);
  });

  it("never reports a clean end without the member's answer", async () => {
    const table = hostTable([row(ROOT, 1), row(20, ROOT), row(80, 1, LATER)]);
    const membership: SandboxMembership = {
      members: () => Promise.reject(new SandboxMembershipUnavailableError("ended")),
      signal: () => Promise.resolve(),
      close: (): void => undefined,
    };
    const sink = createBufferedServerLogSink();
    const descendants = tracker(table, membership, sink.events);
    descendants.start();
    await sampled(table);
    table.rows.splice(0, 1);

    const sweep = await descendants.sweep();
    // What was recorded is still ended; the unseen process cannot be, and the end is unproven.
    expect(sweep).toMatchObject({
      outcome: "membership-unavailable",
      trackedCount: 1,
      signalledCount: 1,
      survivorCount: 0,
    });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(table.rows.map((entry) => entry.pid)).toEqual([80]);
    expect(
      expectActivityLogProof(
        "coding-runtime.descendants.swept.emitted-line",
        formatActivityLogProofLine(sink.events[0] as ServerLogEvent),
      ),
    ).toMatchObject({
      level: "warn",
      outcome: "membership-unavailable",
      frames: expect.any(Array) as unknown,
    });
  });

  it("reports a run without a member as unproven, even when nothing is left", async () => {
    const table = hostTable([row(ROOT, 1)]);
    const descendants = tracker(table);
    descendants.start();
    await sampled(table);
    table.rows.shift();

    const sweep = await descendants.sweep();
    expect(sweep).toMatchObject({ outcome: "unproven", signalledCount: 0, survivorCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  it("never asks about a zombie, which has already ended", async () => {
    const table = hostTable([row(90, 1, LATER, "Z"), row(91, 1, LATER)]);
    const membership = kernel(table, new Set([90, 91]));

    await expect(tracker(table, membership).sweep()).resolves.toMatchObject({
      outcome: "reaped",
      memberCount: 1,
    });
    expect(membership.asked.every((pids) => !pids.includes(90))).toBe(true);
  });

  it("escalates to SIGKILL and reports a member it cannot end", async () => {
    const table = hostTable([row(20, 1)], (pid) => pid === 20);
    const events: ServerLogEvent[] = [];
    const sweep = await tracker(table, kernel(table, new Set([20])), events).sweep();

    expect(sweep).toMatchObject({ outcome: "survivors", signalledCount: 1, survivorCount: 1 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect(table.signals.map((entry) => entry.signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
      "SIGKILL",
      "SIGKILL",
      "SIGKILL",
    ]);
    expect(events[0]).toMatchObject({ level: "warn", errorKind: "internal" });
  });

  it("reports a listing it could not take instead of a clean tree, with its error evidence", async () => {
    const table = hostTable([row(ROOT, 1)]);
    const sink = createBufferedServerLogSink();
    const descendants = tracker(table, kernel(table, new Set()), sink.events);
    table.list.mockRejectedValue(
      new TypeError("ps-unavailable", { cause: new RangeError("ps-output-too-large") }),
    );

    await expect(descendants.sweep()).resolves.toMatchObject({ outcome: "listing-failed" });
    expect(
      expectActivityLogProof(
        "coding-runtime.descendants.swept.emitted-line",
        formatActivityLogProofLine(sink.events[0] as ServerLogEvent),
      ),
    ).toMatchObject({
      level: "warn",
      outcome: "listing-failed",
      causeChain: ["RangeError"],
      frames: expect.any(Array) as unknown,
    });
    expect(sink.lines().join("\n")).not.toMatch(/ps-unavailable|ps-output-too-large/u);
  });

  // Without a member, only a process recorded as the service's descendant is ended, and only while
  // it is still the same process.
  it("never signals a process that reuses a recorded PID", async () => {
    const table = hostTable([row(ROOT, 1), row(20, ROOT)]);
    const descendants = tracker(table);
    descendants.start();
    await sampled(table);
    table.rows.splice(0, table.rows.length, row(20, 1, LATER));

    await expect(descendants.sweep()).resolves.toMatchObject({
      outcome: "unproven",
      signalledCount: 0,
    });
    expect(table.signals).toEqual([]);
  });

  it("counts samples it could not take and signals the host refused", async () => {
    const table = hostTable([row(ROOT, 1), row(20, ROOT)]);
    const descendants = new RuntimeDescendantTracker({
      rootPid: ROOT,
      runId: RUN_ID,
      activityLog: { write: (): void => undefined },
      list: table.list,
      signal: (pid): never => {
        throw Object.assign(new Error("refused"), { code: pid === 20 ? "EPERM" : "ESRCH" });
      },
      sampleIntervalMs: 2,
      settleMs: 1,
    });
    table.list.mockRejectedValueOnce(new Error("busy"));
    descendants.start();
    await sampled(table, 3);
    table.rows.shift();

    await expect(descendants.sweep()).resolves.toMatchObject({
      outcome: "survivors",
      failedSampleCount: 1,
      refusedSignalCount: 5,
    });
  });

  it("sweeps once, stops sampling and ends the member", async () => {
    const table = hostTable([row(ROOT, 1)]);
    const membership = kernel(table, new Set());
    const descendants = tracker(table, membership);
    descendants.start();
    const first = descendants.sweep();

    expect(descendants.sweep()).toBe(first);
    await expect(first).resolves.toMatchObject({ outcome: "clean", trackedCount: 0 });
    expect(membership.closed()).toBe(true);
    const calls = table.list.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(table.list.mock.calls).toHaveLength(calls);
  });
});
