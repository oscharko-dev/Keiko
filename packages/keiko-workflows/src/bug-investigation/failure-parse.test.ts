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

  it.each([
    { location: "file:///repo/pressure%20check.mjs:7:3", file: "/repo/pressure check.mjs" },
    { location: "file:///repo/%C3%BCberhitzung.mjs:7", file: "/repo/überhitzung.mjs" },
    { location: "file://localhost/repo/pressure%20check.mjs:7", file: "/repo/pressure check.mjs" },
    { location: "file:///repo/pressure%2520check.mjs:7", file: "/repo/pressure%20check.mjs" },
    { location: "src/pressure%20check.mjs:7", file: "src/pressure%20check.mjs" },
    { location: "file:///C:/repo/pressure%20check.mjs:7", file: "C:/repo/pressure check.mjs" },
    { location: "file:///c:/repo/pressure%2520check.mjs:7", file: "c:/repo/pressure%20check.mjs" },
  ])("preserves one-pass runtime location identity $location", ({ location, file }) => {
    expect(parseFailureEvidence({ stackTrace: `    at run (${location})` }).frames).toEqual([
      { file, line: 7 },
    ]);
  });

  it.each([
    "file://remote.invalid/repo/guard.mjs:7",
    "file:///repo/bad%ZZ.mjs:7",
    "file:///repo/a%2Fguard.mjs:7",
    "file:///repo/a%5Cguard.mjs:7",
    "file:///repo/a%00guard.mjs:7",
  ])("does not turn an invalid URL into a different filesystem frame: %s", (location) => {
    expect(parseFailureEvidence({ stackTrace: `    at run (${location})` }).frames).toEqual([]);
  });

  it("bounds URL decoding without dropping an ordinary bounded source location", () => {
    expect(
      parseFailureEvidence({ stackTrace: `at file:///repo/${"a".repeat(8192)}.mjs:7` }).frames,
    ).toEqual([]);
    expect(parseFailureEvidence({ stackTrace: "at src/guard.mjs:7" }).frames).toEqual([
      { file: "src/guard.mjs", line: 7 },
    ]);
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

  it("does not mistake timestamps, durations and URLs for source frames", () => {
    const noise = Array.from({ length: 40 }, (_, i) => `10:${String(i).padStart(2, "0")}:11 step`);
    const out = parseFailureEvidence({
      failingOutput: [
        ...noise,
        "[12:30:01]",
        "12:30",
        "2026-11-04T10:15:30 started",
        "listening on http://localhost:3000",
        "    at foo (src/real.ts:3:4)",
      ].join("\n"),
    });
    expect(out.frames).toEqual([{ file: "src/real.ts", line: 3 }]);
  });

  it("does not take a pytest message for the column or put the line into the file", () => {
    const out = parseFailureEvidence({ failingOutput: "tests/test_a.py:12:5: E assert 1 == 2" });
    expect(out.frames).toEqual([{ file: "tests/test_a.py", line: 12 }]);
  });

  it("reads Go, Rust and async-stack locations without their markers", () => {
    const out = parseFailureEvidence({
      failingOutput:
        "\t/repo/main_test.go:15 +0x1d\n   --> src/main.rs:12:5\n  at async /repo/src/a.ts:5:3",
    });
    expect(out.frames).toEqual([
      { file: "/repo/main_test.go", line: 15 },
      { file: "src/main.rs", line: 12 },
      { file: "/repo/src/a.ts", line: 5 },
    ]);
  });

  it("reads ANSI-coloured output as the plain text it colours", () => {
    const esc = String.fromCharCode(27);
    const out = parseFailureEvidence({
      failingOutput: `${esc}[36msrc/x.ts${esc}[39m:3:10\n${esc}[90m ❯ ${esc}[39msrc/y.test.ts:4:1\n${esc}[31mTypeError: boom${esc}[0m`,
    });
    expect(out.frames).toEqual([
      { file: "src/x.ts", line: 3 },
      { file: "src/y.test.ts", line: 4 },
    ]);
    expect(out.messages).toEqual(["TypeError: boom"]);
  });

  it("rejects a location whose file contains a NUL", () => {
    expect(parseFailureEvidence({ stackTrace: "at f (src/a\u0000b.ts:1:1)" }).frames).toEqual([]);
  });

  it("terminates promptly on adversarial input (no catastrophic backtracking)", () => {
    const evil = `${"(".repeat(50_000)}src/x.ts:1:1`;
    const start = Date.now();
    parseFailureEvidence({ failingOutput: evil });
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
