import { describe, expect, it } from "vitest";
import { CliEventSink, MemoryEventSink } from "../../src/harness/sinks.js";
import { DEFAULT_LIMITS } from "../../src/harness/types.js";
import type { HarnessEvent } from "../../src/harness/types.js";

function startedEvent(seq: number): HarnessEvent {
  return {
    schemaVersion: "1",
    runId: "run-1",
    fingerprint: "fp",
    seq,
    ts: seq,
    type: "run:started",
    taskType: "explain-plan",
    modelId: "m",
    limits: DEFAULT_LIMITS,
  };
}

function reasoningEvent(): HarnessEvent {
  return {
    schemaVersion: "1",
    runId: "run-1",
    fingerprint: "fp",
    seq: 2,
    ts: 2,
    type: "reasoning:trace",
    phase: "planning",
    rationale: "SECRET-RATIONALE-VERBATIM",
    modelResponse: "SECRET-MODEL-RESPONSE",
  };
}

function patchEvent(): HarnessEvent {
  return {
    schemaVersion: "1",
    runId: "run-1",
    fingerprint: "fp",
    seq: 3,
    ts: 3,
    type: "patch:proposed",
    targetFile: "src/foo.ts",
    patchBytes: 10,
    diff: "SECRET-DIFF-CONTENT",
  };
}

describe("MemoryEventSink", () => {
  it("appends emitted events and returns them in emission order", () => {
    const sink = new MemoryEventSink();
    sink.emit(startedEvent(1));
    sink.emit(startedEvent(2));
    expect(sink.events().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("collectManifest builds a RunManifest from the run inputs and collected events", () => {
    const sink = new MemoryEventSink();
    sink.emit(startedEvent(1));
    const manifest = sink.collectManifest({
      runId: "run-1",
      fingerprint: "fp",
      harnessVersion: "0.1.0",
      taskType: "explain-plan",
      taskInput: { taskType: "explain-plan", input: { filePath: "src/foo.ts" } },
      limits: DEFAULT_LIMITS,
      modelId: "m",
      startedAt: "2026-05-28T00:00:00.000Z",
    });
    expect(manifest.runId).toBe("run-1");
    expect(manifest.events).toHaveLength(1);
  });
});

describe("CliEventSink", () => {
  it("writes a non-empty line to out() for each event", () => {
    const lines: string[] = [];
    const sink = new CliEventSink({
      out: (t): void => {
        lines.push(t);
      },
      err: (): void => undefined,
    });
    sink.emit(startedEvent(1));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.trim().length).toBeGreaterThan(0);
  });

  it("does not print reasoning rationale or modelResponse verbatim", () => {
    const lines: string[] = [];
    const sink = new CliEventSink({
      out: (t): void => {
        lines.push(t);
      },
      err: (): void => undefined,
    });
    sink.emit(reasoningEvent());
    const joined = lines.join("");
    expect(joined).not.toContain("SECRET-RATIONALE-VERBATIM");
    expect(joined).not.toContain("SECRET-MODEL-RESPONSE");
    expect(joined).toContain("reasoning:trace");
  });

  it("does not print patch diff content verbatim", () => {
    const lines: string[] = [];
    const sink = new CliEventSink({
      out: (t): void => {
        lines.push(t);
      },
      err: (): void => undefined,
    });
    sink.emit(patchEvent());
    expect(lines.join("")).not.toContain("SECRET-DIFF-CONTENT");
  });

  it("routes failure events to err()", () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = new CliEventSink({
      out: (t): void => {
        out.push(t);
      },
      err: (t): void => {
        err.push(t);
      },
    });
    sink.emit({
      schemaVersion: "1",
      runId: "run-1",
      fingerprint: "fp",
      seq: 9,
      ts: 9,
      type: "run:failed",
      atState: "limit-exceeded",
      failure: { category: "HARNESS_LIMIT_ITERATIONS", message: "too many iterations" },
    });
    expect(err.join("")).toContain("HARNESS_LIMIT_ITERATIONS");
  });
});
