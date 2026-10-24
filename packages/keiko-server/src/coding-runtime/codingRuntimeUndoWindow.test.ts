import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { CodingRuntimeHoldResult } from "./codingRuntimeManager.js";
import type { CodingRuntimeRevertState } from "./codingRuntimeRevert.js";
import {
  CODING_RUNTIME_UNDO_WINDOW_MS,
  CodingRuntimeUndoWindow,
  type UndoWindowStagedOutcome,
} from "./codingRuntimeUndoWindow.js";

const RUN_ID = "run-undo-window";
const SECRET = "undo-window-secret-text";

afterEach(() => {
  vi.useRealTimers();
});

interface Subject {
  readonly window: CodingRuntimeUndoWindow;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly commit: ReturnType<typeof vi.fn<(runId: string) => Promise<UndoWindowStagedOutcome>>>;
  readonly stop: ReturnType<typeof vi.fn<(runId: string) => Promise<boolean>>>;
  readonly order: string[];
}

function subject(
  input: {
    readonly staged?: UndoWindowStagedOutcome;
    readonly stopped?: boolean;
    readonly stopFails?: boolean;
    readonly windowMs?: number;
    readonly canHold?: boolean;
    readonly changed?: number | "fails";
    readonly hold?: "held" | "stopped" | "fails";
  } = {},
): Subject {
  const order: string[] = [];
  const log = createBufferedServerLogSink();
  let clock = 1_000;
  const commit = vi.fn((_runId: string) => {
    order.push("commit");
    return Promise.resolve(input.staged ?? "none");
  });
  const stop = vi.fn((_runId: string) => {
    order.push("stop");
    if (input.stopFails === true) return Promise.reject(new Error(`stop failed ${SECRET}`));
    return Promise.resolve(input.stopped ?? true);
  });
  const window = new CodingRuntimeUndoWindow({
    canHold: (): boolean => input.canHold ?? true,
    revertState: (_runId): Promise<CodingRuntimeRevertState | undefined> =>
      input.changed === "fails"
        ? Promise.reject(new Error(`diff failed ${SECRET}`))
        : Promise.resolve({
            staged: false,
            fileCount: input.changed ?? 1,
            additions: 1,
            deletions: 0,
          }),
    hold: (_runId): Promise<CodingRuntimeHoldResult> => {
      order.push("hold");
      if (input.hold === "fails") return Promise.reject(new Error(`hold failed ${SECRET}`));
      return Promise.resolve(
        input.hold === "stopped"
          ? { ok: true as const, status: "stopped" as const }
          : { ok: true as const, status: "held" as const },
      );
    },
    commitStagedRevert: commit,
    stop,
    // The orchestrator runs the expiry on its serial lane; here it runs at once.
    expire: (close): void => {
      void close();
    },
    now: (): number => (clock += 250),
    windowMs: input.windowMs,
    activityLog: log,
  });
  return { window, log, commit, stop, order };
}

describe("the post-completion undo window", () => {
  it("holds the run it was opened for and records the bound", () => {
    const { window, log } = subject({ windowMs: 60_000 });

    window.open(RUN_ID);

    expect(window.heldRunId()).toBe(RUN_ID);
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.undo-window",
        correlationId: RUN_ID,
        extra: { runId: RUN_ID, event: "opened", windowMs: 60_000 },
      },
    ]);
  });

  it("is bounded by thirty minutes unless the caller names another bound", () => {
    const { window, log } = subject();

    window.open(RUN_ID);

    expect(CODING_RUNTIME_UNDO_WINDOW_MS).toBe(30 * 60 * 1_000);
    expect(log.events[0]?.extra).toMatchObject({ windowMs: CODING_RUNTIME_UNDO_WINDOW_MS });
  });

  it("commits a staged undo before it stops the held runtime, then forgets the run", async () => {
    const { window, log, order, commit, stop } = subject({ staged: "committed" });
    window.open(RUN_ID);

    await window.close("next-run");

    expect(order).toEqual(["commit", "stop"]);
    expect(commit).toHaveBeenCalledWith(RUN_ID);
    expect(stop).toHaveBeenCalledWith(RUN_ID);
    expect(window.heldRunId()).toBeUndefined();
    expect(log.events.at(-1)).toMatchObject({
      level: "info",
      extra: {
        event: "closed",
        reason: "next-run",
        stagedRevert: "committed",
        stopped: true,
        openMs: 250,
      },
    });
  });

  it("closes once: a second close finds no window and touches nothing", async () => {
    const { window, commit, stop } = subject();
    window.open(RUN_ID);

    await window.close("next-run");
    await window.close("shutdown");

    expect(commit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no window is open", async () => {
    const { window, log, commit, stop } = subject();

    await window.close("shutdown");

    expect(commit).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(log.events).toEqual([]);
  });

  it("closes itself when its bound passes", async () => {
    vi.useFakeTimers();
    const { window, log, stop } = subject({ windowMs: 5_000 });
    window.open(RUN_ID);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(stop).toHaveBeenCalledWith(RUN_ID);
    expect(window.heldRunId()).toBeUndefined();
    expect(log.events.at(-1)?.extra).toMatchObject({ event: "closed", reason: "expired" });
  });

  it("cancels its expiry once something else closed it", async () => {
    vi.useFakeTimers();
    const { window, stop } = subject({ windowMs: 5_000 });
    window.open(RUN_ID);
    await window.close("next-run");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops a held runtime whose run did not succeed without ever opening a window", async () => {
    const { window, log, stop } = subject();

    await window.release(RUN_ID, "not-succeeded");

    expect(stop).toHaveBeenCalledWith(RUN_ID);
    expect(window.heldRunId()).toBeUndefined();
    expect(log.events).toMatchObject([
      { extra: { event: "closed", reason: "not-succeeded", stopped: true } },
    ]);
  });

  it("reports a commit the runtime refused and a stop that failed at warn", async () => {
    const { window, log } = subject({ staged: "failed", stopped: false });
    window.open(RUN_ID);

    await window.close("shutdown");

    expect(log.events.at(-1)).toMatchObject({
      level: "warn",
      errorKind: "internal",
      extra: { reason: "shutdown", stagedRevert: "failed", stopped: false },
    });
  });

  it("keeps a throwing stop body-free: frames and causes, never the error text", async () => {
    const { window, log } = subject({ stopFails: true });
    window.open(RUN_ID);

    await window.close("next-run");

    const closed = log.events.at(-1);
    expect(closed).toMatchObject({ level: "warn", extra: { stopped: false } });
    expect(closed?.extra).toHaveProperty("causeChain");
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });
});

describe("holding a succeeded run for the window", () => {
  it("holds a runtime whose newest turn changed a file", async () => {
    const { window, order } = subject();

    await expect(window.hold(RUN_ID)).resolves.toEqual({ stopped: true, held: true });
    expect(order).toEqual(["hold"]);
  });

  it("leaves a runtime it cannot hold, or a turn that changed nothing, to the ordinary stop", async () => {
    for (const input of [{ canHold: false }, { changed: 0 }] as const) {
      const { window, order } = subject(input);
      await expect(window.hold(RUN_ID)).resolves.toBeUndefined();
      expect(order).toEqual([]);
    }
  });

  it("reports a runtime the manager stopped instead of holding it", async () => {
    const { window } = subject({ hold: "stopped" });

    await expect(window.hold(RUN_ID)).resolves.toEqual({ stopped: true, held: false });
  });

  it("says why on the log, body-free, when the changes cannot be read or the hold fails", async () => {
    const unreadable = subject({ changed: "fails" });
    await expect(unreadable.window.hold(RUN_ID)).resolves.toBeUndefined();
    const failing = subject({ hold: "fails" });
    await expect(failing.window.hold(RUN_ID)).resolves.toEqual({ stopped: false, held: false });

    for (const { log } of [unreadable, failing]) {
      expect(log.events).toMatchObject([
        { level: "warn", errorKind: "internal", extra: { runId: RUN_ID, event: "hold-failed" } },
      ]);
      expect(JSON.stringify(log.events)).not.toContain(SECRET);
    }
  });
});

describe("registered Activity Log proof", () => {
  it("proves coding-runtime.undo-window", async () => {
    const { window, log } = subject({ staged: "committed" });
    window.open(RUN_ID);
    await window.close("next-run");

    const [opened, closed] = log.events;
    if (opened === undefined || closed === undefined) throw new Error("expected two lines");
    expect(
      expectActivityLogProof(
        "coding-runtime.undo-window.emitted-line",
        formatActivityLogProofLine(opened),
      ),
    ).toMatchObject({ runId: RUN_ID, event: "opened" });
    expect(
      expectActivityLogProof(
        "coding-runtime.undo-window.emitted-line",
        formatActivityLogProofLine(closed),
      ),
    ).toMatchObject({ runId: RUN_ID, event: "closed", stagedRevert: "committed", stopped: true });
  });
});
