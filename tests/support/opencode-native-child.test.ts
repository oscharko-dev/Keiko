import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  assertNativeCleanupFailure,
  nativeChildEndpoint,
  stopNativeChild,
  withNativeChild,
} from "./opencode-native-child.js";

function fixtureChild(source: string): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
}

const READY = '{"url":"http://127.0.0.1:43123"}\n';
const HOLD = "setInterval(() => {}, 1000);";

describe("native fixture child resources (hermetic Node children, not native qualification)", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it(`reads canonical readiness from ${stream} and removes only its own listeners`, async (): Promise<void> => {
      const child = fixtureChild(`${HOLD} process.${stream}.write(${JSON.stringify(READY)});`);
      const observed: Buffer[] = [];
      const unrelated = (bytes: Buffer): void => {
        observed.push(bytes);
      };
      child.stdout.on("data", unrelated);
      try {
        expect(await nativeChildEndpoint(child)).toBe("http://127.0.0.1:43123");
        expect(child.stdout.listeners("data")).toEqual([unrelated]);
        expect(child.stderr.listenerCount("data")).toBe(0);
        expect(child.listenerCount("error")).toBe(0);
        expect(child.listenerCount("exit")).toBe(0);
        expect(Buffer.concat(observed).toString("utf8")).toBe(stream === "stdout" ? READY : "");
      } finally {
        child.stdout.off("data", unrelated);
        await stopNativeChild(child);
      }
      expect(child.signalCode).toBe("SIGKILL");
    });
  }

  it("refuses a real child that exits before readiness and releases listeners", async (): Promise<void> => {
    const child = fixtureChild("process.exit(0);");
    try {
      await expect(nativeChildEndpoint(child)).rejects.toThrow("fixture-child-exited");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      await stopNativeChild(child);
    }
  });

  it("refuses an already reaped child without waiting for another exit", async (): Promise<void> => {
    const child = fixtureChild("process.exit(0);");
    try {
      await once(child, "exit");
      await expect(nativeChildEndpoint(child)).rejects.toThrow("fixture-child-exited");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
    } finally {
      await stopNativeChild(child);
    }
  });

  it("uses the closed startup error label for a real failed spawn", async (): Promise<void> => {
    const child = spawn(process.execPath + ".fixture-missing", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await expect(nativeChildEndpoint(child)).rejects.toThrow("fixture-startup-failed");
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("times out refused readiness and releases listeners before immediate kill and reap", async (): Promise<void> => {
    const child = fixtureChild(`${HOLD} process.stdout.write('not readiness\\n');`);
    try {
      await expect(nativeChildEndpoint(child, 30)).rejects.toThrow("fixture-startup-timeout");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
    } finally {
      await stopNativeChild(child);
    }
    expect(child.signalCode).toBe("SIGKILL");
    await stopNativeChild(child);
  });

  it("retains the default twenty-second deadline and releases its timer on timeout", async (): Promise<void> => {
    const child = fixtureChild(HOLD);
    try {
      await once(child, "spawn");
      vi.useFakeTimers();
      const endpoint = nativeChildEndpoint(child);
      const rejected = expect(endpoint).rejects.toThrow("fixture-startup-timeout");
      await vi.advanceTimersByTimeAsync(19_999);
      expect(child.stdout.listenerCount("data")).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
    } finally {
      vi.useRealTimers();
      await stopNativeChild(child);
    }
  });

  it("retains chunk-local parsing rather than joining incomplete readiness records", async (): Promise<void> => {
    const child = fixtureChild(HOLD);
    try {
      const endpoint = nativeChildEndpoint(child);
      child.stdout.emit("data", Buffer.from('{"url":"http://127.0.0.1:43123"'));
      child.stdout.emit("data", Buffer.from("}\n"));
      expect(child.stdout.listenerCount("data")).toBe(1);
      child.stderr.emit("data", Buffer.from(READY));
      expect(await endpoint).toBe("http://127.0.0.1:43123");
    } finally {
      await stopNativeChild(child);
    }
  });

  it("reaps an acquired child after its productive body completes", async (): Promise<void> => {
    const child = fixtureChild(HOLD);
    try {
      await withNativeChild(child, async (): Promise<void> => {
        await once(child, "spawn");
      });
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      await stopNativeChild(child);
    }
  });

  it("reaps an acquired child when a later setup step rejects with its original error", async (): Promise<void> => {
    const child = fixtureChild(HOLD);
    const primary: Error = Object.freeze(new TypeError("fixture-later-acquisition-refused"));
    try {
      const failed = withNativeChild(child, (): Promise<void> => Promise.reject(primary));
      await expect(failed).rejects.toBe(primary);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      await stopNativeChild(child);
    }
  });

  it("retains primary and cleanup identities if immediate child termination throws", async (): Promise<void> => {
    const child = fixtureChild(HOLD);
    const primary: Error = Object.freeze(new TypeError("fixture-primary-refused"));
    const cleanup: Error = Object.freeze(new TypeError("fixture-kill-refused"));
    const kill = vi.spyOn(child, "kill").mockImplementationOnce((): never => {
      throw cleanup;
    });
    try {
      const failure: unknown = await withNativeChild(child, (): Promise<void> =>
        Promise.reject(primary),
      ).then(
        (): undefined => undefined,
        (error: unknown): unknown => error,
      );
      assertNativeCleanupFailure(failure, primary, cleanup);
    } finally {
      kill.mockRestore();
      await stopNativeChild(child);
    }
  });
});
