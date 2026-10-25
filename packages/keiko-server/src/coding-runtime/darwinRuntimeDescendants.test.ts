import { describe, expect, it, vi } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { RuntimeDescendantTracker, sweepProvesEnd } from "./darwinRuntimeDescendants.js";
import {
  SandboxMembershipUnavailableError,
  type SandboxMembership,
} from "./darwinSandboxMembership.js";

const RUN_ID = "run-descendants";

// One sandbox instance as the kernel answers its member: the processes besides the member, those a
// SIGKILL cannot end, and what happens while a broadcast is delivered.
interface Instance {
  readonly processes: Set<number>;
  readonly unkillable: Set<number>;
  broadcasts: number;
  /** Runs during a broadcast, after the processes it reached have been ended. */
  duringBroadcast?: (() => void) | undefined;
}

function instance(processes: readonly number[], unkillable: readonly number[] = []): Instance {
  return { processes: new Set(processes), unkillable: new Set(unkillable), broadcasts: 0 };
}

function member(table: Instance): SandboxMembership {
  return {
    occupied: (): Promise<boolean> => Promise.resolve(table.processes.size > 0),
    killAll: (): Promise<void> => {
      table.broadcasts += 1;
      for (const pid of [...table.processes])
        if (!table.unkillable.has(pid)) table.processes.delete(pid);
      table.duringBroadcast?.();
      return Promise.resolve();
    },
    close: vi.fn(),
  };
}

function tracker(
  membership: SandboxMembership | undefined,
  events: ServerLogEvent[] = [],
): RuntimeDescendantTracker {
  return new RuntimeDescendantTracker({
    runId: RUN_ID,
    activityLog: { write: (event) => void events.push(event) },
    ...(membership === undefined ? {} : { membership }),
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
  it("proves a clean end when the kernel reports no process of the run, and signals nothing", async () => {
    const table = instance([]);
    const membership = member(table);
    const close = vi.spyOn(membership, "close");
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(membership, sink.events).sweep();

    expect(sweep).toEqual({ outcome: "clean", roundCount: 0, checkCount: 1 });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(table.broadcasts).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(line(sink.events[0])).toMatchObject({
      level: "info",
      op: "coding-runtime.descendants.swept",
      correlationId: RUN_ID,
      outcome: "clean",
      roundCount: 0,
      checkCount: 1,
    });
  });

  it("ends every remaining process and proves it once the kernel reports none", async () => {
    const table = instance([40, 41, 42]);
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(member(table), sink.events).sweep();

    expect(sweep).toEqual({ outcome: "reaped", roundCount: 1, checkCount: 2 });
    expect(sweepProvesEnd(sweep)).toBe(true);
    expect(table.processes.size).toBe(0);
    expect(line(sink.events[0])).toMatchObject({ level: "info", outcome: "reaped", roundCount: 1 });
  });

  // PR #4064 review (4371619368, 4371860462): a process of the run can fork while the kernel delivers
  // a broadcast, so its child is missed. The proof never rests on a listing or a PID: it is the
  // kernel's answer that no process remains, so the next broadcast reaches the child.
  it("reaches a process forked during a broadcast with the next one", async () => {
    const table = instance([40]);
    let forks = 3;
    table.duringBroadcast = (): void => {
      if (forks > 0) table.processes.add(1_000 + forks);
      forks -= 1;
    };
    const sweep = await tracker(member(table)).sweep();

    expect(sweep).toMatchObject({ outcome: "reaped", roundCount: 4, checkCount: 5 });
    expect(table.processes.size).toBe(0);
  });

  it("never proves an end while a process outlives every broadcast", async () => {
    const table = instance([40, 41], [41]);
    const events: ServerLogEvent[] = [];
    const sweep = await tracker(member(table), events).sweep();

    expect(sweep).toMatchObject({ outcome: "survivors", roundCount: 50 });
    expect(sweepProvesEnd(sweep)).toBe(false);
    expect([...table.processes]).toEqual([41]);
    expect(line(events[0])).toMatchObject({ level: "warn", outcome: "survivors" });
    expect(events[0]).toMatchObject({ errorKind: "internal" });
  });

  // PR #4064 review (4371619380): without the member's answer a host signal could reach anything.
  it("signals nothing and proves nothing when the member no longer answers", async () => {
    const killAll = vi.fn(() => Promise.resolve());
    const membership: SandboxMembership = {
      occupied: () => Promise.reject(new SandboxMembershipUnavailableError("ended")),
      killAll,
      close: vi.fn(),
    };
    const sink = createBufferedServerLogSink();
    const sweep = await tracker(membership, sink.events).sweep();

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

  it("proves nothing when the member stops answering during the sweep", async () => {
    const table = instance([40]);
    const membership: SandboxMembership = {
      ...member(table),
      killAll: () => Promise.reject(new SandboxMembershipUnavailableError("timeout")),
    };
    const sweep = await tracker(membership).sweep();

    expect(sweep).toMatchObject({ outcome: "membership-unavailable" });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  it("reports a run without a member as unproven and signals nothing", async () => {
    const sweep = await tracker(undefined).sweep();

    expect(sweep).toEqual({ outcome: "unproven", roundCount: 0, checkCount: 0 });
    expect(sweepProvesEnd(sweep)).toBe(false);
  });

  it("sweeps once", async () => {
    const table = instance([40]);
    const descendants = tracker(member(table));
    const first = descendants.sweep();

    expect(descendants.sweep()).toBe(first);
    await expect(first).resolves.toMatchObject({ outcome: "reaped" });
    expect(table.broadcasts).toBe(1);
  });
});
