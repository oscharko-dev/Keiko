import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  NATIVE_CHILD_SESSION_MAX,
  NATIVE_SESSION_ANCESTRY_MAX_DEPTH,
  admitNativeChildren,
  classifyNativeSession,
  createNativeTreeStatusPort,
  interruptNativeTree,
  nativeSessionDescendsFromRun,
  nativeTreeActivity,
  type NativeSessionTreeClient,
  type NativeSessionTreeRun,
} from "./opencodeNativeSessionTree.js";

const WORKSPACE = "/workspace/repository";
const PRIMARY = "ses_primary";

type SessionRecord = Readonly<Record<string, unknown>>;

function session(id: string, parentID?: string, directory = WORKSPACE): SessionRecord {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    location: { directory },
  };
}

interface FakeRuntime {
  readonly client: NativeSessionTreeClient;
  readonly interrupts: string[];
  sessionReads: number;
  sessions: readonly SessionRecord[];
  /** What the runtime reports active; one entry per read, the last one repeats. */
  active: (readonly string[])[];
  failSessions: boolean;
  onInterrupt: (id: string) => void;
}

function fakeRuntime(sessions: readonly SessionRecord[], active: readonly string[]): FakeRuntime {
  const runtime: FakeRuntime = {
    interrupts: [],
    sessionReads: 0,
    sessions,
    active: [active],
    failSessions: false,
    onInterrupt: () => undefined,
    client: {
      active: () => {
        const ids = runtime.active.length > 1 ? runtime.active.shift() : runtime.active[0];
        return Promise.resolve(
          Object.fromEntries((ids ?? []).map((id) => [id, { type: "running" }])),
        );
      },
      sessions: () => {
        runtime.sessionReads += 1;
        return runtime.failSessions
          ? Promise.reject(new Error("sessions-unavailable"))
          : Promise.resolve(runtime.sessions);
      },
      interrupt: (id) => {
        runtime.interrupts.push(id);
        runtime.onInterrupt(id);
        return Promise.resolve();
      },
    },
  };
  return runtime;
}

function tree(children: readonly string[] = []): NativeSessionTreeRun {
  return { sessionId: PRIMARY, workspaceRoot: WORKSPACE, children: new Set(children) };
}

const instantPause = (signal: AbortSignal): Promise<boolean> => Promise.resolve(!signal.aborted);

describe("the run's native session ancestry", () => {
  it("admits a session whose parent chain reaches the primary inside the workspace", () => {
    const sessions = [session("ses_child", PRIMARY), session("ses_grandchild", "ses_child")];
    expect(nativeSessionDescendsFromRun(sessions, "ses_child", PRIMARY, WORKSPACE)).toBe(true);
    expect(nativeSessionDescendsFromRun(sessions, "ses_grandchild", PRIMARY, WORKSPACE)).toBe(true);
  });

  it("refuses a session without a parent, with a cycle, outside the workspace or too deep", () => {
    expect(nativeSessionDescendsFromRun([session("ses_x")], "ses_x", PRIMARY, WORKSPACE)).toBe(
      false,
    );
    expect(
      nativeSessionDescendsFromRun(
        [session("ses_a", "ses_b"), session("ses_b", "ses_a")],
        "ses_a",
        PRIMARY,
        WORKSPACE,
      ),
    ).toBe(false);
    expect(
      nativeSessionDescendsFromRun(
        [session("ses_child", PRIMARY, "/elsewhere")],
        "ses_child",
        PRIMARY,
        WORKSPACE,
      ),
    ).toBe(false);
    const chain = Array.from({ length: NATIVE_SESSION_ANCESTRY_MAX_DEPTH + 1 }, (_, index) =>
      session(`ses_${String(index)}`, index === 0 ? PRIMARY : `ses_${String(index - 1)}`),
    );
    expect(
      nativeSessionDescendsFromRun(
        chain,
        `ses_${String(NATIVE_SESSION_ANCESTRY_MAX_DEPTH)}`,
        PRIMARY,
        WORKSPACE,
      ),
    ).toBe(false);
  });

  it("refuses a session whose chain leaves the workspace halfway", () => {
    const sessions = [
      session("ses_middle", PRIMARY, "/elsewhere"),
      session("ses_leaf", "ses_middle", WORKSPACE),
    ];
    expect(nativeSessionDescendsFromRun(sessions, "ses_leaf", PRIMARY, WORKSPACE)).toBe(false);
  });
});

describe("admitting native children", () => {
  it("admits proven descendants, once for all candidates, and keeps the proof", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY), session("ses_b", PRIMARY)], []);
    const run = tree();
    await expect(
      admitNativeChildren(runtime.client, run, ["ses_a", "ses_b"], undefined),
    ).resolves.toEqual(["ses_a", "ses_b"]);
    expect(runtime.sessionReads).toBe(1);
    // A proven child needs no further read.
    await expect(admitNativeChildren(runtime.client, run, ["ses_a"], undefined)).resolves.toEqual([
      "ses_a",
    ]);
    expect(runtime.sessionReads).toBe(1);
    expect([...run.children]).toEqual(["ses_a", "ses_b"]);
  });

  it("never admits the primary, a stranger or a session of another workspace", async () => {
    const runtime = fakeRuntime(
      [session("ses_stranger"), session("ses_other", PRIMARY, "/elsewhere")],
      [],
    );
    const run = tree();
    await expect(
      admitNativeChildren(
        runtime.client,
        run,
        [PRIMARY, "ses_stranger", "ses_other", "ses_gone"],
        undefined,
      ),
    ).resolves.toEqual([]);
    expect(run.children.size).toBe(0);
  });

  it("reads nothing when every candidate is already proven, or there are none", async () => {
    const runtime = fakeRuntime([], []);
    await admitNativeChildren(runtime.client, tree(["ses_a"]), ["ses_a"], undefined);
    await admitNativeChildren(runtime.client, tree(), [], undefined);
    expect(runtime.sessionReads).toBe(0);
  });

  it("admits no further child once the bound is reached", async () => {
    const proven = Array.from({ length: NATIVE_CHILD_SESSION_MAX }, (_, i) => `ses_c${String(i)}`);
    const runtime = fakeRuntime([session("ses_late", PRIMARY)], []);
    const run = tree(proven);
    await expect(
      admitNativeChildren(runtime.client, run, ["ses_late"], undefined),
    ).resolves.toEqual([]);
    expect(run.children.size).toBe(NATIVE_CHILD_SESSION_MAX);
    expect(runtime.sessionReads).toBe(0);
  });

  it("throws when the session list cannot be read, so nothing is admitted unproven", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], []);
    runtime.failSessions = true;
    const run = tree();
    await expect(admitNativeChildren(runtime.client, run, ["ses_a"], undefined)).rejects.toThrow(
      "sessions-unavailable",
    );
    expect(run.children.size).toBe(0);
  });

  it("classifies the primary, a child and a stranger", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY), session("ses_x")], []);
    const run = tree();
    await expect(classifyNativeSession(runtime.client, run, PRIMARY, undefined)).resolves.toBe(
      "primary",
    );
    await expect(classifyNativeSession(runtime.client, run, "ses_a", undefined)).resolves.toBe(
      "child",
    );
    await expect(classifyNativeSession(runtime.client, run, "ses_x", undefined)).resolves.toBe(
      undefined,
    );
  });
});

describe("the run's native session tree activity", () => {
  it("reports an owned child that runs while the primary is idle", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], ["ses_a"]);
    await expect(nativeTreeActivity(runtime.client, tree(), undefined)).resolves.toEqual({
      primaryActive: false,
      activeChildren: ["ses_a"],
      ownedChildCount: 1,
    });
  });

  it("ignores an active session that is not the run's, and a key that is no session id", async () => {
    const runtime = fakeRuntime([session("ses_x")], ["ses_x", "not-a-session", "ses_y"]);
    await expect(nativeTreeActivity(runtime.client, tree(), undefined)).resolves.toMatchObject({
      primaryActive: false,
      activeChildren: [],
    });
  });

  it("reads no session list while only the primary runs", async () => {
    const runtime = fakeRuntime([], [PRIMARY]);
    await expect(nativeTreeActivity(runtime.client, tree(), undefined)).resolves.toMatchObject({
      primaryActive: true,
      activeChildren: [],
    });
    expect(runtime.sessionReads).toBe(0);
  });
});

describe("the run's native session tree status", () => {
  function statusPort(
    runtime: FakeRuntime,
    activityLog = createBufferedServerLogSink(),
  ): {
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
    readonly status: ReturnType<typeof createNativeTreeStatusPort>;
  } {
    const run = tree();
    return {
      activityLog,
      status: createNativeTreeStatusPort({
        runId: "run-tree",
        client: runtime.client,
        tree: () => run,
        activityLog,
      }),
    };
  }
  const signal = new AbortController().signal;

  it("is terminal only when the primary and every owned child are inactive", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], [PRIMARY, "ses_a"]);
    const { status } = statusPort(runtime);
    await expect(status(PRIMARY, signal)).resolves.toBe("activity");
    runtime.active = [["ses_a"]];
    await expect(status(PRIMARY, signal)).resolves.toBe("held");
    runtime.active = [[]];
    await expect(status(PRIMARY, signal)).resolves.toBe("terminal");
  });

  it("is not kept alive by a session that is not the run's", async () => {
    const runtime = fakeRuntime([session("ses_x")], ["ses_x"]);
    await expect(statusPort(runtime).status(PRIMARY, signal)).resolves.toBe("terminal");
  });

  it("throws rather than report terminal when it cannot prove who is running", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], ["ses_a"]);
    runtime.failSessions = true;
    await expect(statusPort(runtime).status(PRIMARY, signal)).rejects.toThrow(
      "sessions-unavailable",
    );
  });

  it("writes one line when the run starts being held and one when it stops, never per poll", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], ["ses_a"]);
    const { status, activityLog } = statusPort(runtime);
    for (let poll = 0; poll < 5; poll += 1) await status(PRIMARY, signal);
    runtime.active = [[]];
    for (let poll = 0; poll < 3; poll += 1) await status(PRIMARY, signal);
    const lines = activityLog.events.filter(
      (event) => event.op === "coding-runtime.native-session-tree.observed",
    );
    expect(lines.map((line) => line.extra)).toEqual([
      expect.objectContaining({
        phase: "held",
        primaryActive: false,
        activeChildCount: 1,
        ownedChildCount: 1,
      }) as unknown,
      expect.objectContaining({ phase: "released", activeChildCount: 0 }) as unknown,
    ]);
    expect(lines[0]).toMatchObject({ correlationId: "run-tree" });
    expect(JSON.stringify(lines)).not.toContain("ses_a");
    expectActivityLogProof(
      "coding-runtime.native-session-tree.observed.emitted-line",
      formatActivityLogProofLine(lines[0] ?? {}),
    );
  });

  it("writes nothing for a run that never had a child", async () => {
    const runtime = fakeRuntime([], [PRIMARY]);
    const { status, activityLog } = statusPort(runtime);
    await status(PRIMARY, signal);
    runtime.active = [[]];
    await status(PRIMARY, signal);
    expect(activityLog.events).toEqual([]);
  });
});

describe("interrupting the run's native session tree", () => {
  function options(signal = new AbortController().signal): Parameters<
    typeof interruptNativeTree
  >[2] & {
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const activityLog = createBufferedServerLogSink();
    return { signal, pause: instantPause, runId: "run-tree", activityLog };
  }

  it("interrupts the primary first, then every owned child, and settles on two idle reads", async () => {
    const runtime = fakeRuntime(
      [session("ses_a", PRIMARY), session("ses_b", PRIMARY)],
      ["ses_a", "ses_b"],
    );
    runtime.active = [["ses_a", "ses_b"], [], []];
    const run = tree();
    const settings = options();
    const outcome = await interruptNativeTree(runtime.client, run, settings);
    expect(runtime.interrupts).toEqual([PRIMARY, "ses_a", "ses_b"]);
    expect(outcome).toEqual({ interruptedChildren: 2, settled: true });
    const line = settings.activityLog.events.find(
      (event) => event.op === "coding-runtime.native-session-tree.observed",
    );
    expect(line?.extra).toMatchObject({
      phase: "interrupted",
      activeChildCount: 2,
      ownedChildCount: 2,
    });
    expectActivityLogProof(
      "coding-runtime.native-session-tree.observed.emitted-line",
      formatActivityLogProofLine(line ?? {}),
    );
  });

  it("does not settle on a single idle read: a child's end starts the parent's next turn", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], []);
    // Idle, then the parent runs the turn that reads the child's report, then idle for good.
    runtime.active = [[], [PRIMARY], [], []];
    const outcome = await interruptNativeTree(runtime.client, tree(), options());
    expect(outcome.settled).toBe(true);
    // The first interrupt was no-op against an idle parent; the revived turn is interrupted too.
    expect(runtime.interrupts).toEqual([PRIMARY, PRIMARY]);
  });

  it("interrupts a primary that came back, but not one still running from the first interrupt", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], []);
    runtime.active = [[PRIMARY], [PRIMARY], [PRIMARY], [], []];
    await interruptNativeTree(runtime.client, tree(), options());
    expect(runtime.interrupts).toEqual([PRIMARY]);
  });

  it("sends one interrupt per child however long it takes the child to stop", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], ["ses_a"]);
    runtime.active = [["ses_a"], ["ses_a"], ["ses_a"], [], []];
    const outcome = await interruptNativeTree(runtime.client, tree(), options());
    expect(runtime.interrupts.filter((id) => id === "ses_a")).toHaveLength(1);
    expect(outcome.interruptedChildren).toBe(1);
  });

  it("never interrupts a session that is not the run's", async () => {
    const runtime = fakeRuntime([session("ses_x")], ["ses_x"]);
    runtime.active = [["ses_x"], [], []];
    const settings = options();
    await interruptNativeTree(runtime.client, tree(), settings);
    expect(runtime.interrupts).toEqual([PRIMARY]);
    expect(settings.activityLog.events).toEqual([]);
  });

  it("reports an unsettled tree when the signal ends first", async () => {
    const runtime = fakeRuntime([session("ses_a", PRIMARY)], ["ses_a"]);
    const stop = new AbortController();
    runtime.onInterrupt = (id): void => {
      if (id === "ses_a") stop.abort();
    };
    const outcome = await interruptNativeTree(runtime.client, tree(), options(stop.signal));
    expect(outcome).toEqual({ interruptedChildren: 1, settled: false });
  });

  it("fails when an interrupt request fails", async () => {
    const runtime = fakeRuntime([], []);
    runtime.onInterrupt = (): void => {
      throw new Error("interrupt-refused");
    };
    await expect(interruptNativeTree(runtime.client, tree(), options())).rejects.toThrow(
      "interrupt-refused",
    );
  });
});
