import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import {
  HUMAN_WRITE_WAIT_MS,
  HumanWriteGateTimeoutError,
  isNativeWorkspaceWriteRunning,
  nativeWriteGateWaiters,
  NATIVE_WRITE_WAIT_MS,
  NativeWriteGateTimeoutError,
  openNativeWriteGateEntries,
  runHumanWorkspaceWrite,
  runNativeWorkspaceWrite,
} from "./nativeWriteGate.js";
import { recordWriteGateTimeout } from "./opencodeRevert.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-gate-"));
  roots.push(root);
  return root;
}

interface Latch {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly hold: () => Promise<void>;
}

/** A write body that signals it started and keeps running until it is released. */
function latch(): Latch {
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    hold: async (): Promise<void> => {
      enter();
      await released;
    },
  };
}

/** Resolves once `count` writes are waiting inside the gate, so "not run yet" is proven, not slept. */
async function waiting(count: number): Promise<void> {
  for (let turn = 0; turn < 1_000 && nativeWriteGateWaiters() !== count; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(nativeWriteGateWaiters()).toBe(count);
}

describe("the native-write gate", () => {
  it("holds a person's write until the runtime's write in flight has ended", async () => {
    const root = directory();
    const order: string[] = [];
    const native = latch();
    const running = runNativeWorkspaceWrite(root, async () => {
      await native.hold();
      order.push("native");
    });
    await native.entered;
    const human = runHumanWorkspaceWrite(root, () => {
      order.push("human");
      return Promise.resolve();
    });
    await waiting(1);
    expect(order).toEqual([]);
    native.release();
    await Promise.all([running, human]);

    expect(order).toEqual(["native", "human"]);
  });

  it("makes a runtime write wait for the person's writes already running", async () => {
    const root = directory();
    const order: string[] = [];
    const human = latch();
    const typing = runHumanWorkspaceWrite(root, async () => {
      await human.hold();
      order.push("human");
    });
    await human.entered;
    const native = runNativeWorkspaceWrite(root, () => {
      order.push("native");
      return Promise.resolve();
    });
    await waiting(1);
    expect(order).toEqual([]);
    human.release();
    await Promise.all([typing, native]);

    expect(order).toEqual(["human", "native"]);
  });

  it("queues two runtime writes of one workspace one after the other", async () => {
    const root = directory();
    const order: string[] = [];
    const first = latch();
    const one = runNativeWorkspaceWrite(root, async () => {
      await first.hold();
      order.push("first");
    });
    await first.entered;
    const two = runNativeWorkspaceWrite(root, () => {
      order.push("second");
      return Promise.resolve();
    });
    await waiting(1);
    expect(order).toEqual([]);
    first.release();
    await Promise.all([one, two]);

    expect(order).toEqual(["first", "second"]);
  });

  it("never lets a person's write run beside a runtime write queued while it waited (the wake race)", async () => {
    const root = directory();
    const order: string[] = [];
    const first = latch();
    const second = latch();
    const one = runNativeWorkspaceWrite(root, async () => {
      await first.hold();
      order.push("native-1");
    });
    await first.entered;
    const human = runHumanWorkspaceWrite(root, () => {
      order.push("human");
      return Promise.resolve();
    });
    // A second runtime write is queued while the person's write already waits for the first.
    const two = runNativeWorkspaceWrite(root, async () => {
      await second.hold();
      order.push("native-2");
    });
    first.release();
    await one;
    await second.entered;
    await waiting(1);
    // The person's write has not run beside the second runtime write.
    expect(order).toEqual(["native-1"]);
    second.release();
    await Promise.all([two, human]);

    expect(order).toEqual(["native-1", "native-2", "human"]);
  });

  it("orders a root that contains, or is contained in, the runtime's workspace, both ways", async () => {
    const parent = directory();
    const child = join(parent, "packages", "app");
    mkdirSync(child, { recursive: true });
    for (const [nativeRoot, humanRoot] of [
      [child, parent],
      [parent, child],
    ] as const) {
      const order: string[] = [];
      const native = latch();
      const running = runNativeWorkspaceWrite(nativeRoot, async () => {
        await native.hold();
        order.push("native");
      });
      await native.entered;
      const human = runHumanWorkspaceWrite(humanRoot, () => {
        order.push("human");
        return Promise.resolve();
      });
      await waiting(1);
      expect(order).toEqual([]);
      native.release();
      await Promise.all([running, human]);
      expect(order).toEqual(["native", "human"]);
    }
  });

  it("does not order a sibling folder whose name merely starts the same", async () => {
    const parent = directory();
    const one = join(parent, "app");
    const two = join(parent, "app-other");
    mkdirSync(one);
    mkdirSync(two);
    const native = latch();
    const running = runNativeWorkspaceWrite(one, () => native.hold());
    await native.entered;

    await expect(runHumanWorkspaceWrite(two, () => Promise.resolve("free"))).resolves.toBe("free");
    native.release();
    await running;
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "orders case variants of one folder where the file system ignores case",
    async () => {
      const root = directory();
      const order: string[] = [];
      const native = latch();
      const running = runNativeWorkspaceWrite(root, async () => {
        await native.hold();
        order.push("native");
      });
      await native.entered;
      const human = runHumanWorkspaceWrite(root.toUpperCase(), () => {
        order.push("human");
        return Promise.resolve();
      });
      await waiting(1);
      expect(order).toEqual([]);
      native.release();
      await Promise.all([running, human]);

      expect(order).toEqual(["native", "human"]);
    },
  );

  it("releases the gate when a write throws, and leaves no entry behind", async () => {
    const root = directory();
    await expect(
      runNativeWorkspaceWrite(root, () => Promise.reject(new Error("native failed"))),
    ).rejects.toThrow("native failed");
    await expect(
      runHumanWorkspaceWrite(root, () => Promise.reject(new Error("human failed"))),
    ).rejects.toThrow("human failed");

    await expect(runHumanWorkspaceWrite(root, () => Promise.resolve("after"))).resolves.toBe(
      "after",
    );
    await expect(runNativeWorkspaceWrite(root, () => Promise.resolve("after"))).resolves.toBe(
      "after",
    );
    expect(openNativeWriteGateEntries()).toBe(0);
  });

  it("fails a person's write closed, with a body-free log line, when the runtime write never ends", async () => {
    const root = directory();
    const native = latch();
    const running = runNativeWorkspaceWrite(root, () => native.hold());
    await native.entered;
    const log = createBufferedServerLogSink();
    const write = vi.fn(() => Promise.resolve("saved"));
    vi.useFakeTimers();
    try {
      const human = runHumanWorkspaceWrite(root, write, HUMAN_WRITE_WAIT_MS, {
        onTimeout: (_side, waitedMs) => {
          recordWriteGateTimeout(log, waitedMs, "corr-human-gate-0001");
        },
      });
      const outcome = expect(human).rejects.toBeInstanceOf(HumanWriteGateTimeoutError);
      await vi.advanceTimersByTimeAsync(HUMAN_WRITE_WAIT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(write).not.toHaveBeenCalled();
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.refused",
        level: "warn",
        correlationId: "corr-human-gate-0001",
        errorKind: "timeout",
        extra: { operation: "write", reason: "write-gate-timeout", waitBucketMs: 30_000 },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(root);
    native.release();
    await running;
    expect(openNativeWriteGateEntries()).toBe(0);
  });

  it("runs the same person's write at once when no runtime write is running (positive control)", async () => {
    const root = directory();
    const onTimeout = vi.fn();

    await expect(
      runHumanWorkspaceWrite(root, () => Promise.resolve("saved"), HUMAN_WRITE_WAIT_MS, {
        onTimeout,
      }),
    ).resolves.toBe("saved");
    expect(onTimeout).not.toHaveBeenCalled();
    expect(isNativeWorkspaceWriteRunning(root)).toBe(false);
  });

  it("reports a runtime write in flight to a synchronous writer, related roots included", async () => {
    const parent = directory();
    const child = join(parent, "pkg");
    mkdirSync(child);
    const native = latch();
    const running = runNativeWorkspaceWrite(child, () => native.hold());
    await native.entered;

    expect(isNativeWorkspaceWriteRunning(parent)).toBe(true);
    expect(isNativeWorkspaceWriteRunning(child)).toBe(true);
    native.release();
    await running;
    expect(isNativeWorkspaceWriteRunning(parent)).toBe(false);
  });

  it("orders a root that does not exist yet by its nearest existing ancestor", async () => {
    const parent = directory();
    const native = latch();
    const running = runNativeWorkspaceWrite(join(parent, "later", "deep"), () => native.hold());
    await native.entered;

    expect(isNativeWorkspaceWriteRunning(parent)).toBe(true);
    expect(isNativeWorkspaceWriteRunning(join(parent, "elsewhere"))).toBe(false);
    native.release();
    await running;
  });

  it("gives up a runtime write that waits too long for a person's write, sending nothing", async () => {
    const root = directory();
    const human = latch();
    const typing = runHumanWorkspaceWrite(root, () => human.hold());
    await human.entered;
    const write = vi.fn(() => Promise.resolve("sent"));
    const onTimeout = vi.fn();
    vi.useFakeTimers();
    try {
      const native = runNativeWorkspaceWrite(root, write, NATIVE_WRITE_WAIT_MS, { onTimeout });
      const outcome = expect(native).rejects.toBeInstanceOf(NativeWriteGateTimeoutError);
      await vi.advanceTimersByTimeAsync(NATIVE_WRITE_WAIT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(onTimeout).toHaveBeenCalledWith("native", NATIVE_WRITE_WAIT_MS);
    expect(write).not.toHaveBeenCalled();
    human.release();
    await typing;
    expect(openNativeWriteGateEntries()).toBe(0);
  });
});
