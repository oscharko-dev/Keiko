import { describe, expect, it } from "vitest";
import {
  computeBugFingerprint,
  createBugEventEmitter,
} from "../../../src/workflows/bug-investigation/emit.js";
import { recordingSink } from "./_support.js";
import type { BugReportInput } from "../../../src/workflows/bug-investigation/types.js";

const REPORT: BugReportInput = { description: "bug", failingOutput: "boom" };

describe("computeBugFingerprint", () => {
  it("is deterministic for the same report + model", () => {
    expect(computeBugFingerprint(REPORT, "m")).toBe(computeBugFingerprint(REPORT, "m"));
  });

  it("is insensitive to key order in the report (canonicalised)", () => {
    const a: BugReportInput = { description: "bug", failingOutput: "boom" };
    const b: BugReportInput = { failingOutput: "boom", description: "bug" };
    expect(computeBugFingerprint(a, "m")).toBe(computeBugFingerprint(b, "m"));
  });

  it("differs for a different model id", () => {
    expect(computeBugFingerprint(REPORT, "m")).not.toBe(computeBugFingerprint(REPORT, "n"));
  });

  it("is a 16-char hex string", () => {
    expect(computeBugFingerprint(REPORT, "m")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createBugEventEmitter", () => {
  it("stamps the shared envelope and a monotonic seq, then forwards to the sink", () => {
    const sink = recordingSink();
    let clock = 100;
    const emitter = createBugEventEmitter(sink.sink, "run-1", "fp-1", () => clock);
    emitter.emit({ type: "bug:failure:parsed", frameCount: 2, messageCount: 1 });
    clock = 200;
    emitter.emit({ type: "bug:completed", status: "fix-proposed", durationMs: 5 });
    const events = sink.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: "1",
      runId: "run-1",
      fingerprint: "fp-1",
      seq: 1,
      ts: 100,
      type: "bug:failure:parsed",
      frameCount: 2,
    });
    expect(events[1]).toMatchObject({
      seq: 2,
      ts: 200,
      type: "bug:completed",
      status: "fix-proposed",
    });
  });
});
