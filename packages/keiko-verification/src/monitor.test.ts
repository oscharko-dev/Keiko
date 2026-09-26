import { describe, expect, it } from "vitest";
import { nodeResourceMonitor, readProcessTreeRssBytes } from "./monitor.js";

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

  it("reports complete process-tree enforcement as unavailable on every host", () => {
    let fired = false;
    const unwatch = nodeResourceMonitor.watch(process.pid, 1, () => {
      fired = true;
    });
    unwatch();
    expect(fired).toBe(false);
    expect(nodeResourceMonitor.canEnforceProcessTreeMemory()).toBe(false);
    expect(readProcessTreeRssBytes(process.pid)).toBeUndefined();
  });
});
