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
  parseWorkingDirectories,
  RuntimeDescendantTracker,
  type ProcessIdentity,
} from "./darwinRuntimeDescendants.js";

const ROOT = 4_711;
const RUN_ID = "run-descendants";
const STARTED = "Sun Oct 25 14:50:39 2026";
const LATER = "Sun Oct 25 14:59:01 2026";

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
      const index = rows.findIndex((row) => row.pid === pid);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

function tracker(table: HostTable, events: ServerLogEvent[] = []): RuntimeDescendantTracker {
  return new RuntimeDescendantTracker({
    rootPid: ROOT,
    runId: RUN_ID,
    activityLog: { write: (event) => void events.push(event) },
    list: table.list,
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

describe("macOS runtime descendants (#3899 AC2)", () => {
  it("parses a locale-independent listing and ignores anything else", () => {
    expect(
      parseProcessListing(
        `  ${String(ROOT)}     1 ${STARTED}\n  12 ${String(ROOT)} ${LATER}\ngarbage\n\n`,
      ),
    ).toEqual([
      { pid: ROOT, ppid: 1, started: STARTED },
      { pid: 12, ppid: ROOT, started: LATER },
    ]);
  });

  it("finds every descendant of the roots, roots excluded", () => {
    const rows = [
      { pid: ROOT, ppid: 1, started: STARTED },
      { pid: 20, ppid: ROOT, started: STARTED },
      { pid: 21, ppid: 20, started: STARTED },
      { pid: 22, ppid: 21, started: STARTED },
      { pid: 30, ppid: 1, started: STARTED },
    ];
    expect(descendantsOf(rows, new Set([ROOT])).map((row) => row.pid)).toEqual([20, 21, 22]);
  });

  it("ends the recorded children of an exited service and theirs, and records it", async () => {
    const table = hostTable([
      { pid: ROOT, ppid: 1, started: STARTED },
      { pid: 20, ppid: ROOT, started: STARTED },
      { pid: 21, ppid: ROOT, started: STARTED },
    ]);
    const sink = createBufferedServerLogSink();
    const descendants = tracker(table, sink.events);
    descendants.start();
    await sampled(table);
    // The service crashes: its children move to launchd, and one forks a grandchild there.
    table.rows.splice(
      0,
      table.rows.length,
      ...[
        { pid: 20, ppid: 1, started: STARTED },
        { pid: 21, ppid: 1, started: STARTED },
        { pid: 22, ppid: 21, started: LATER },
      ],
    );

    await expect(descendants.sweep()).resolves.toEqual({
      outcome: "reaped",
      trackedCount: 3,
      signalledCount: 3,
      survivorCount: 0,
      failedSampleCount: 0,
      refusedSignalCount: 0,
      adoptedCount: 0,
    });
    expect(table.signals).toEqual([
      { pid: 20, signal: "SIGTERM" },
      { pid: 21, signal: "SIGTERM" },
      { pid: 22, signal: "SIGTERM" },
    ]);
    const [line] = sink.lines();
    expect(sink.lines()).toHaveLength(1);
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
      trackedCount: 3,
      signalledCount: 3,
      survivorCount: 0,
    });
    expect(line).not.toContain(STARTED);
  });

  it("never signals a process that reuses a recorded PID", async () => {
    const table = hostTable([
      { pid: ROOT, ppid: 1, started: STARTED },
      { pid: 20, ppid: ROOT, started: STARTED },
    ]);
    const descendants = tracker(table);
    descendants.start();
    await sampled(table);
    table.rows.splice(0, table.rows.length, { pid: 20, ppid: 1, started: LATER });

    await expect(descendants.sweep()).resolves.toMatchObject({
      outcome: "clean",
      signalledCount: 0,
    });
    expect(table.signals).toEqual([]);
  });

  it("escalates to SIGKILL and reports a process it cannot end", async () => {
    const table = hostTable(
      [
        { pid: ROOT, ppid: 1, started: STARTED },
        { pid: 20, ppid: ROOT, started: STARTED },
      ],
      (pid) => pid === 20,
    );
    const events: ServerLogEvent[] = [];
    const descendants = tracker(table, events);
    descendants.start();
    await sampled(table);
    table.rows.shift();

    await expect(descendants.sweep()).resolves.toEqual({
      outcome: "survivors",
      trackedCount: 1,
      signalledCount: 1,
      survivorCount: 1,
      failedSampleCount: 0,
      refusedSignalCount: 0,
      adoptedCount: 0,
    });
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
    const table = hostTable([{ pid: ROOT, ppid: 1, started: STARTED }]);
    const sink = createBufferedServerLogSink();
    const descendants = tracker(table, sink.events);
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

  it("counts samples it could not take and signals the host refused", async () => {
    const table = hostTable([
      { pid: ROOT, ppid: 1, started: STARTED },
      { pid: 20, ppid: ROOT, started: STARTED },
    ]);
    const descendants = new RuntimeDescendantTracker({
      rootPid: ROOT,
      runId: RUN_ID,
      activityLog: { write: (): void => undefined },
      list: table.list,
      signal: (pid): never => {
        const refused = Object.assign(new Error("refused"), {
          code: pid === 20 ? "EPERM" : "ESRCH",
        });
        throw refused;
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

  // #3901 AC3: `cmd &` hands its process to launchd at once, so it never appears below the service.
  describe("processes a command detached", () => {
    const WORKSPACE = "/managed/ws_1";
    const BEFORE = "Sun Oct 25 14:40:00 2026";

    function adopting(
      table: HostTable,
      directories: Readonly<Record<number, string>>,
    ): RuntimeDescendantTracker {
      return new RuntimeDescendantTracker({
        rootPid: ROOT,
        runId: RUN_ID,
        activityLog: { write: (): void => undefined },
        list: table.list,
        workspaceRoots: [WORKSPACE],
        directoriesOf: (pids) =>
          Promise.resolve(
            new Map(
              pids.flatMap((pid) => (pid in directories ? [[pid, directories[pid] ?? ""]] : [])),
            ),
          ),
        signal: table.signal,
        sampleIntervalMs: 2,
        settleMs: 1,
      });
    }

    it("ends a launchd child of the run's workspace that started while the service ran", async () => {
      const table = hostTable([{ pid: ROOT, ppid: 1, started: STARTED }]);
      const descendants = adopting(table, {
        40: `${WORKSPACE}/src`,
        41: "/Users/someone",
        42: WORKSPACE,
        43: "/managed/ws_10",
      });
      descendants.start();
      await sampled(table);
      table.rows.splice(
        0,
        table.rows.length,
        ...[
          { pid: 40, ppid: 1, started: LATER },
          { pid: 41, ppid: 1, started: LATER },
          { pid: 42, ppid: 1, started: BEFORE },
          { pid: 43, ppid: 1, started: LATER },
          { pid: 44, ppid: 40, started: LATER },
        ],
      );

      await expect(descendants.sweep()).resolves.toMatchObject({
        outcome: "reaped",
        adoptedCount: 1,
        signalledCount: 2,
      });
      expect(table.signals.map((entry) => entry.pid)).toEqual([40, 44]);
    });

    it("adopts nothing before it has seen the service start", async () => {
      const table = hostTable([{ pid: 40, ppid: 1, started: LATER }]);
      const descendants = adopting(table, { 40: WORKSPACE });

      await expect(descendants.sweep()).resolves.toMatchObject({
        outcome: "clean",
        adoptedCount: 0,
      });
      expect(table.signals).toEqual([]);
    });

    it("reads lsof's process and name records", () => {
      expect(parseWorkingDirectories("p40\nfcwd\nn/managed/ws_1\np41\nfcwd\nn/tmp\n")).toEqual(
        new Map([
          [40, "/managed/ws_1"],
          [41, "/tmp"],
        ]),
      );
    });
  });

  it("sweeps once and stops sampling", async () => {
    const table = hostTable([{ pid: ROOT, ppid: 1, started: STARTED }]);
    const descendants = tracker(table);
    descendants.start();
    const first = descendants.sweep();

    expect(descendants.sweep()).toBe(first);
    await expect(first).resolves.toMatchObject({ outcome: "clean", trackedCount: 0 });
    const calls = table.list.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(table.list.mock.calls).toHaveLength(calls);
  });
});
