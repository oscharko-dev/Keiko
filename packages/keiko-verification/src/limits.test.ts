import { describe, expect, it } from "vitest";
import { buildAppliedLimits } from "./limits.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";

describe("buildAppliedLimits — honest enforced flags (ADR-0007 D2)", () => {
  it("always records all four dimensions in a stable order", () => {
    const rows = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined);
    expect(rows.map((r) => r.dimension)).toEqual(["wall-time", "output-size", "memory", "network"]);
  });

  it("wall-time and output-size are enforced; network is never enforced", () => {
    const rows = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined);
    const by = (d: string): boolean => rows.find((r) => r.dimension === d)?.enforced ?? false;
    expect(by("wall-time")).toBe(true);
    expect(by("output-size")).toBe(true);
    expect(by("network")).toBe(false);
  });

  it("network carries the documented-not-enforced note for an inherited-network run", () => {
    const net = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined).find(
      (r) => r.dimension === "network",
    );
    expect(net?.note).toContain("container wave");
  });

  it("network is enforced and notes the keiko-sandbox boundary when the run attests it (ADR-0043)", () => {
    const net = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined, true).find(
      (r) => r.dimension === "network",
    );
    expect(net?.enforced).toBe(true);
    expect(net?.note).toContain("keiko-sandbox");
  });

  it("reports process-tree memory enforcement only when the monitor attests it", () => {
    const withCeiling = { ...DEFAULT_VERIFICATION_LIMITS, maxMemoryBytes: 1024 };
    const enforced = buildAppliedLimits(withCeiling, undefined, false, true).find(
      (r) => r.dimension === "memory",
    );
    const unavailable = buildAppliedLimits(withCeiling, undefined, false, false).find(
      (r) => r.dimension === "memory",
    );
    expect(enforced?.enforced).toBe(true);
    expect(enforced?.note).toBeUndefined();
    expect(unavailable?.enforced).toBe(false);
    expect(unavailable?.note).toContain("process-tree");
  });

  it("memory is never enforced without a ceiling, even on Linux", () => {
    const mem = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined).find(
      (r) => r.dimension === "memory",
    );
    expect(mem?.enforced).toBe(false);
  });

  it("sets breached:true on exactly the dimension that fired", () => {
    const rows = buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, "output-size");
    const breached = rows.filter((r) => r.breached === true);
    expect(breached).toHaveLength(1);
    expect(breached[0]?.dimension).toBe("output-size");
  });
});
