// The process guards convert a stray async crash into ONE clean, body-free line
// plus a fail-fast exit(1) — never a raw stack, never payload contents.
import { describe, expect, it, vi } from "vitest";
import { fatalProcessLine, installProcessGuards } from "./process-guards.js";

describe("fatalProcessLine", () => {
  it("names the error kind and message without a stack", () => {
    const line = fatalProcessLine("uncaught exception", new TypeError("boom at /tmp/x"));
    expect(line).toBe("keiko: fatal uncaught exception (TypeError: boom at /tmp/x). The process will exit.\n");
    expect(line).not.toContain("    at ");
  });

  it("handles string and opaque rejection reasons", () => {
    expect(fatalProcessLine("unhandled rejection", "plain reason")).toContain("(plain reason)");
    expect(fatalProcessLine("unhandled rejection", { weird: true })).toContain("(unknown cause)");
    expect(fatalProcessLine("unhandled rejection", undefined)).toContain("(unknown cause)");
  });
});

describe("installProcessGuards", () => {
  it("registers both catch-alls against an injected sink and exits 1", () => {
    const onSpy = vi.spyOn(process, "on");
    const err = vi.fn();
    const exit = vi.fn();
    try {
      installProcessGuards({ err, exit });
      const uncaught = onSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1] as
        | ((error: Error) => void)
        | undefined;
      const rejection = onSpy.mock.calls.find(([event]) => event === "unhandledRejection")?.[1] as
        | ((reason: unknown) => void)
        | undefined;
      expect(uncaught).toBeDefined();
      expect(rejection).toBeDefined();

      uncaught?.(new Error("late failure"));
      expect(err).toHaveBeenCalledWith(
        "keiko: fatal uncaught exception (Error: late failure). The process will exit.\n",
      );
      expect(exit).toHaveBeenCalledWith(1);

      rejection?.("nope");
      expect(err).toHaveBeenCalledWith(
        "keiko: fatal unhandled rejection (nope). The process will exit.\n",
      );
    } finally {
      // Remove the listeners this test installed so the vitest process keeps its
      // own crash semantics.
      const uncaught = onSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
      const rejection = onSpy.mock.calls.find(([event]) => event === "unhandledRejection")?.[1];
      if (uncaught !== undefined) process.removeListener("uncaughtException", uncaught as never);
      if (rejection !== undefined) process.removeListener("unhandledRejection", rejection as never);
      onSpy.mockRestore();
    }
  });
});
