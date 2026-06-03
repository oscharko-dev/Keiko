import { describe, expect, it } from "vitest";
import { MAX_FRAMES, parseFailureEvidence } from "./failure-parse.js";

describe("parseFailureEvidence (AC #4 / AC #9 failure-output handling)", () => {
  it("extracts a node stack frame of the form `at fn (path:line:col)`", () => {
    const out = parseFailureEvidence({
      stackTrace:
        "    at half (src/buggy.ts:3:10)\n    at Object.<anonymous> (tests/buggy.test.ts:7:5)",
    });
    expect(out.frames).toContainEqual({ file: "src/buggy.ts", line: 3 });
    expect(out.frames).toContainEqual({ file: "tests/buggy.test.ts", line: 7 });
  });

  it("extracts a bare `at path:line:col` frame (no function name)", () => {
    const out = parseFailureEvidence({ stackTrace: "    at src/buggy.ts:12:3" });
    expect(out.frames).toContainEqual({ file: "src/buggy.ts", line: 12 });
  });

  it("strips a file:// URL prefix before peeling line:col", () => {
    const out = parseFailureEvidence({
      stackTrace: "    at half (file:///repo/src/buggy.ts:3:10)",
    });
    expect(out.frames).toContainEqual({ file: "/repo/src/buggy.ts", line: 3 });
  });

  it("extracts a vitest-style bare `path:line:col` from failing output", () => {
    const out = parseFailureEvidence({
      failingOutput: " FAIL  tests/buggy.test.ts > half halves\nsrc/buggy.ts:3:10",
    });
    expect(out.frames).toContainEqual({ file: "src/buggy.ts", line: 3 });
  });

  it("captures short assertion/error message lines", () => {
    const out = parseFailureEvidence({
      failingOutput: "AssertionError: expected 3 to equal 4\n  at half (src/buggy.ts:3:10)",
    });
    expect(out.messages.some((m) => m.includes("expected 3 to equal 4"))).toBe(true);
  });

  it("dedupes frames by file+line", () => {
    const out = parseFailureEvidence({
      stackTrace: "    at a (src/buggy.ts:3:10)\n    at b (src/buggy.ts:3:99)",
    });
    const matches = out.frames.filter((f) => f.file === "src/buggy.ts" && f.line === 3);
    expect(matches).toHaveLength(1);
  });

  it("merges input.targetFiles as line-less frames (developer-provided lead is a verified seed)", () => {
    const out = parseFailureEvidence({ targetFiles: ["src/other.ts"] });
    expect(out.frames).toContainEqual({ file: "src/other.ts", line: undefined });
  });

  it("caps the number of frames at MAX_FRAMES", () => {
    const lines = Array.from(
      { length: MAX_FRAMES + 50 },
      (_, i) => `    at f (src/f${String(i)}.ts:1:1)`,
    );
    const out = parseFailureEvidence({ stackTrace: lines.join("\n") });
    expect(out.frames.length).toBeLessThanOrEqual(MAX_FRAMES);
  });

  it("does not inspect frames after the configured scan-line cap", () => {
    const lines = Array.from({ length: 2_001 }, (_, i) =>
      i === 2_000 ? "at late (src/late.ts:1:1)" : "noise",
    );
    const out = parseFailureEvidence({ failingOutput: lines.join("\n") });
    expect(out.frames.some((frame) => frame.file === "src/late.ts")).toBe(false);
  });

  it("returns empty evidence when no source is present", () => {
    const out = parseFailureEvidence({ description: "it just feels slow" });
    expect(out.frames).toEqual([]);
    expect(out.messages).toEqual([]);
  });

  it("does not treat a non-numeric line token as a line number", () => {
    const out = parseFailureEvidence({ stackTrace: "    at f (src/buggy.ts:abc:def)" });
    // No valid line:col → not parsed as a frame (we require a numeric line).
    expect(out.frames.every((f) => f.file !== "src/buggy.ts")).toBe(true);
  });

  it("terminates promptly on adversarial input (no catastrophic backtracking)", () => {
    const evil = `${"(".repeat(50_000)}src/x.ts:1:1`;
    const start = Date.now();
    parseFailureEvidence({ failingOutput: evil });
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
