import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeResourceMonitor } from "./monitor.js";

describe("nodeResourceMonitor — documented no-op paths", () => {
  it("returns a no-op unwatch when no memory ceiling is requested", () => {
    const unwatch = nodeResourceMonitor.watch(1234, undefined, () => {
      throw new Error("onBreach must not fire");
    });
    expect(typeof unwatch).toBe("function");
    expect(() => {
      unwatch();
    }).not.toThrow();
  });

  it("returns a no-op unwatch when pid is undefined", () => {
    const unwatch = nodeResourceMonitor.watch(undefined, 1024, () => {
      throw new Error("onBreach must not fire");
    });
    expect(() => {
      unwatch();
    }).not.toThrow();
  });

  it("on non-Linux platforms watch is a no-op (memory dimension is enforced:false there)", () => {
    if (process.platform === "linux") {
      return; // covered by the Linux sampler test below
    }
    let fired = false;
    const unwatch = nodeResourceMonitor.watch(process.pid, 1, () => {
      fired = true;
    });
    unwatch();
    expect(fired).toBe(false);
  });
});

const linuxProc = process.platform === "linux" && existsSync("/proc/self/status");

describe.skipIf(!linuxProc)("nodeResourceMonitor — Linux /proc sampler", () => {
  it("fires onBreach when RSS exceeds a tiny ceiling, then unwatch clears the interval", async () => {
    const fired = await new Promise<boolean>((resolve) => {
      // A 1-byte ceiling is exceeded by any live process; the 250ms sampler should trip once.
      const unwatch = nodeResourceMonitor.watch(process.pid, 1, () => {
        unwatch();
        resolve(true);
      });
      setTimeout(() => {
        unwatch();
        resolve(false);
      }, 2_000);
    });
    expect(fired).toBe(true);
  });
});
