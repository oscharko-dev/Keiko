import { describe, expect, it } from "vitest";
import { VERIFICATION_MAX_FAILURE_LOCATIONS } from "@oscharko-dev/keiko-contracts";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import { extractFailureLocations } from "./failure-location.js";

function cmd(stdout: string, stderr = ""): CommandResult {
  return {
    command: "npm",
    args: [],
    exitCode: 1,
    signal: null,
    stdout,
    stderr,
    durationMs: 1,
    timedOut: false,
    truncated: false,
  };
}

describe("extractFailureLocations — typecheck (reliable, AC10)", () => {
  it("parses the tsc default diagnostic format with file/line/column/ruleId", () => {
    const out = extractFailureLocations(
      "typecheck",
      cmd("src/a.ts(12,34): error TS2322: Type 'string' is not assignable to type 'number'."),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      file: "src/a.ts",
      line: 12,
      column: 34,
      message: "Type 'string' is not assignable to type 'number'.",
      ruleId: "TS2322",
    });
  });

  it("collects multiple diagnostics and dedupes identical file:line:col", () => {
    const out = extractFailureLocations(
      "typecheck",
      cmd(
        [
          "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
          "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
          "src/b.ts(9,2): error TS1005: ';' expected.",
        ].join("\n"),
      ),
    );
    expect(out.map((l) => l.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("extractFailureLocations — lint (best-effort)", () => {
  it("attributes ESLint stylish rows to the preceding file header", () => {
    const out = extractFailureLocations(
      "lint",
      cmd(
        [
          "/repo/src/a.ts",
          "  12:34  error  'x' is assigned a value but never used  no-unused-vars",
          "  15:2   warning  Missing semicolon  semi",
          "",
          "/repo/src/b.ts",
          "  1:1  error  Unexpected console statement  no-console",
        ].join("\n"),
      ),
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.file).toBe("/repo/src/a.ts");
    expect(out[0]?.line).toBe(12);
    expect(out[0]?.ruleId).toBe("no-unused-vars");
    expect(out[2]?.file).toBe("/repo/src/b.ts");
  });
});

describe("extractFailureLocations — test (best-effort)", () => {
  it("parses vitest failure stack frames with the failure title as the message", () => {
    const out = extractFailureLocations(
      "test",
      cmd(
        [
          " FAIL  src/a.test.ts > my suite > does a thing",
          "AssertionError: expected 1 to be 2",
          " ❯ src/a.test.ts:12:34",
        ].join("\n"),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("src/a.test.ts");
    expect(out[0]?.line).toBe(12);
    expect(out[0]?.message).toContain("does a thing");
  });

  it("treats targeted-test the same as test", () => {
    const out = extractFailureLocations("targeted-test", cmd(" ❯ src/a.test.ts:5:1"));
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(5);
  });
});

describe("extractFailureLocations — degrade to empty, never throw (AC11)", () => {
  it("returns empty for the build kind regardless of output", () => {
    expect(extractFailureLocations("build", cmd("anything at all"))).toEqual([]);
  });

  it("returns empty for a missing result", () => {
    expect(extractFailureLocations("typecheck", undefined)).toEqual([]);
  });

  it("returns empty (never throws, never fabricates) for unrecognized output per kind", () => {
    for (const kind of ["typecheck", "lint", "test"] as const) {
      expect(extractFailureLocations(kind, cmd("some unrelated log line"))).toEqual([]);
      expect(extractFailureLocations(kind, cmd(""))).toEqual([]);
    }
  });
});

describe("extractFailureLocations — bounded (cap enforcement)", () => {
  it("clamps to the contract's per-result location cap", () => {
    const many = Array.from(
      { length: VERIFICATION_MAX_FAILURE_LOCATIONS + 10 },
      (_unused, index) => `src/f${String(index)}.ts(1,1): error TS2304: Cannot find name 'x'.`,
    ).join("\n");
    const out = extractFailureLocations("typecheck", cmd(many));
    expect(out).toHaveLength(VERIFICATION_MAX_FAILURE_LOCATIONS);
  });

  it("drops a non-positive line rather than surfacing a fabricated coordinate", () => {
    const out = extractFailureLocations(
      "typecheck",
      cmd("src/a.ts(0,5): error TS2322: Type 'string' is not assignable to type 'number'."),
    );
    expect(out).toEqual([]);
  });
});

describe("extractFailureLocations — branch edge cases (bounded parsing)", () => {
  it("attributes an ESLint row with no rule-id and omits ruleId", () => {
    const out = extractFailureLocations(
      "lint",
      cmd(["/repo/src/a.ts", "  3:7  error  Something is wrong"].join("\n")),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(3);
    expect(out[0]?.ruleId).toBeUndefined();
  });

  it("ignores an ESLint row that appears before any file header", () => {
    const out = extractFailureLocations(
      "lint",
      cmd(
        [
          "  9:9  error  Orphan row with no file  no-rule",
          "/repo/src/b.ts",
          "  1:1  error  Real  x",
        ].join("\n"),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("/repo/src/b.ts");
  });

  it("skips a pathological over-long line rather than matching it", () => {
    const longFile = "s".repeat(5000);
    const out = extractFailureLocations("typecheck", cmd(`${longFile}(1,1): error TS1: x`));
    expect(out).toEqual([]);
  });

  it("uses a default message for a vitest frame with no preceding title", () => {
    const out = extractFailureLocations("test", cmd("   at src/x.test.ts:3:9"));
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe("Test failure");
  });
});

describe("extractFailureLocations — message capping", () => {
  it("caps an over-long diagnostic message to the contract character bound", () => {
    const out = extractFailureLocations(
      "typecheck",
      cmd(`src/a.ts(1,1): error TS2: ${"x".repeat(900)}`),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message.length ?? 0).toBeLessThanOrEqual(512);
    expect(out[0]?.message.length ?? 0).toBeGreaterThan(400);
  });
});
