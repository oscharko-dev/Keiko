import { describe, expect, it } from "vitest";
import {
  createRunRegistry,
  ActiveRunLimitError,
  type RunRegistry,
  type RegisterRunInput,
} from "./runs.js";
import { QueueEventSink } from "./sink.js";

function reg(now: () => number, maxActiveRuns = 2, terminatedTtlMs = 1000): RunRegistry {
  return createRunRegistry({ now, maxActiveRuns, terminatedTtlMs });
}

function registerInput(runId: string): RegisterRunInput {
  return {
    runId,
    fingerprint: "fp",
    modelId: "test-model",
    sink: new QueueEventSink(),
    cancel: (): void => undefined,
  };
}

describe("run registry capacity", () => {
  it("refuses a new run past the active cap", () => {
    const registry = reg(() => 0, 2);
    registry.register(registerInput("a"));
    registry.register(registerInput("b"));
    expect(() => registry.register(registerInput("c"))).toThrow(ActiveRunLimitError);
    expect(registry.activeCount()).toBe(2);
  });

  it("frees a slot once a run terminates", () => {
    const registry = reg(() => 0, 2);
    registry.register(registerInput("a"));
    registry.register(registerInput("b"));
    registry.complete("a", "completed", { ok: true }, undefined);
    expect(registry.activeCount()).toBe(1);
    expect(() => registry.register(registerInput("c"))).not.toThrow();
  });
});

describe("run registry TTL eviction", () => {
  it("evicts a terminated record only after the TTL elapses", () => {
    let clock = 0;
    const registry = reg(() => clock, 4, 1000);
    registry.register(registerInput("a"));
    registry.complete("a", "completed", { ok: true }, undefined);
    clock = 999;
    // A register triggers eviction; just under TTL the record survives.
    registry.register(registerInput("b"));
    expect(registry.get("a")).toBeDefined();
    clock = 1000;
    registry.register(registerInput("c"));
    expect(registry.get("a")).toBeUndefined();
  });

  it("never evicts a still-running record", () => {
    let clock = 0;
    const registry = reg(() => clock, 4, 10);
    registry.register(registerInput("a"));
    clock = 1_000_000;
    registry.register(registerInput("b"));
    expect(registry.get("a")).toBeDefined();
  });

  it("evicts expired terminated records during idle reads", () => {
    let clock = 0;
    const registry = reg(() => clock, 4, 10);
    registry.register(registerInput("a"));
    registry.complete("a", "completed", { ok: true }, undefined);
    clock = 50;
    expect(registry.get("a")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });
});

describe("run registry completion capture", () => {
  it("captures status, report, and appliable snapshot", () => {
    const registry = reg(() => 0);
    registry.register(registerInput("a"));
    registry.complete("a", "completed", { status: "dry-run" }, {
      kind: "unit-tests",
      payload: { workspaceRoot: "." },
      limits: undefined,
    });
    const record = registry.get("a");
    expect(record?.status).toBe("completed");
    expect(record?.report).toEqual({ status: "dry-run" });
    expect(record?.appliable).toMatchObject({ kind: "unit-tests" });
    expect(record?.applyReport).toBeUndefined();
    expect(record?.appliedAt).toBeUndefined();
  });

  it("ignores completion of an unknown run", () => {
    const registry = reg(() => 0);
    expect(() => { registry.complete("missing", "failed", {}, undefined); }).not.toThrow();
  });
});
