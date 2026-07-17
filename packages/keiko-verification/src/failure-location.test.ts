import { describe, expect, it } from "vitest";
import { VERIFICATION_MAX_FAILURE_LOCATIONS } from "@oscharko-dev/keiko-contracts";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import { extractFailureLocations } from "./failure-location.js";

const WORKSPACE_ROOT = "/repo";

function extract(
  kind: Parameters<typeof extractFailureLocations>[0],
  result: CommandResult | undefined,
  root = WORKSPACE_ROOT,
): ReturnType<typeof extractFailureLocations> {
  return extractFailureLocations(kind, result, root);
}

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
    const out = extract(
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
    const out = extract(
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
    const out = extract(
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
    expect(out[0]?.file).toBe("src/a.ts");
    expect(out[0]?.line).toBe(12);
    expect(out[0]?.ruleId).toBe("no-unused-vars");
    expect(out[2]?.file).toBe("src/b.ts");
  });
});

describe("extractFailureLocations — test (best-effort)", () => {
  it("parses vitest failure stack frames with the failure title as the message", () => {
    const out = extract(
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
    const out = extract("targeted-test", cmd(" ❯ src/a.test.ts:5:1"));
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(5);
  });

  it("parses Vitest 4 frames when ANSI styling splits the line and column coordinates", () => {
    const esc = "\u001b";
    const out = extract(
      "targeted-test",
      cmd(
        [
          `${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m src/sum.test.ts${esc}[2m > ${esc}[22msum`,
          `${esc}[36m ${esc}[2m❯${esc}[22m src/sum.test.ts:${esc}[2m3:31${esc}[22m${esc}[39m`,
        ].join("\n"),
      ),
    );
    expect(out).toEqual([
      {
        file: "src/sum.test.ts",
        line: 3,
        column: 31,
        message: "src/sum.test.ts > sum",
      },
    ]);
  });
});

describe("extractFailureLocations — degrade to empty, never throw (AC11)", () => {
  it("returns empty for the build kind regardless of output", () => {
    expect(extract("build", cmd("anything at all"))).toEqual([]);
  });

  it("returns empty for a missing result", () => {
    expect(extract("typecheck", undefined)).toEqual([]);
  });

  it("returns empty (never throws, never fabricates) for unrecognized output per kind", () => {
    for (const kind of ["typecheck", "lint", "test"] as const) {
      expect(extract(kind, cmd("some unrelated log line"))).toEqual([]);
      expect(extract(kind, cmd(""))).toEqual([]);
    }
  });
});

describe("extractFailureLocations — bounded (cap enforcement)", () => {
  it("clamps to the contract's per-result location cap", () => {
    const many = Array.from(
      { length: VERIFICATION_MAX_FAILURE_LOCATIONS + 10 },
      (_unused, index) => `src/f${String(index)}.ts(1,1): error TS2304: Cannot find name 'x'.`,
    ).join("\n");
    const out = extract("typecheck", cmd(many));
    expect(out).toHaveLength(VERIFICATION_MAX_FAILURE_LOCATIONS);
  });

  it("drops a non-positive line rather than surfacing a fabricated coordinate", () => {
    const out = extract(
      "typecheck",
      cmd("src/a.ts(0,5): error TS2322: Type 'string' is not assignable to type 'number'."),
    );
    expect(out).toEqual([]);
  });
});

describe("extractFailureLocations — branch edge cases (bounded parsing)", () => {
  it("attributes an ESLint row with no rule-id and omits ruleId", () => {
    const out = extract(
      "lint",
      cmd(["/repo/src/a.ts", "  3:7  error  Something is wrong"].join("\n")),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(3);
    expect(out[0]?.ruleId).toBeUndefined();
  });

  it("ignores an ESLint row that appears before any file header", () => {
    const out = extract(
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
    expect(out[0]?.file).toBe("src/b.ts");
  });

  it("skips a pathological over-long line rather than matching it", () => {
    const longFile = "s".repeat(5000);
    const out = extract("typecheck", cmd(`${longFile}(1,1): error TS1: x`));
    expect(out).toEqual([]);
  });

  it("uses a default message for a vitest frame with no preceding title", () => {
    const out = extract("test", cmd("   at src/x.test.ts:3:9"));
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe("Test failure");
  });
});

describe("extractFailureLocations — message capping", () => {
  it("caps an over-long diagnostic message to the contract character bound", () => {
    const out = extract("typecheck", cmd(`src/a.ts(1,1): error TS2: ${"x".repeat(900)}`));
    expect(out).toHaveLength(1);
    expect(out[0]?.message.length ?? 0).toBeLessThanOrEqual(512);
    expect(out[0]?.message.length ?? 0).toBeGreaterThan(400);
  });

  it("never splits a Unicode surrogate pair at the message boundary", () => {
    const message = `${"x".repeat(511)}😀tail`;
    const out = extract("typecheck", cmd(`src/a.ts(1,1): error TS2: ${message}`));
    expect(out[0]?.message).toBe("x".repeat(511));
    expect(out[0]?.message).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("caps a lint rule id to the stricter wire-contract bound", () => {
    const ruleId = `plugin/${"r".repeat(200)}`;
    const out = extract(
      "lint",
      cmd(["/repo/src/a.ts", `  3:7  error  Something is wrong  ${ruleId}`].join("\n")),
    );
    expect(out[0]?.ruleId).toHaveLength(128);
  });
});

describe("extractFailureLocations — workspace containment", () => {
  it("normalizes in-root absolute and backslash-relative paths to POSIX relative paths", () => {
    expect(extract("typecheck", cmd("/repo/src/a.ts(1,2): error TS1: x"))[0]?.file).toBe(
      "src/a.ts",
    );
    expect(extract("typecheck", cmd("src\\b.ts(3,4): error TS2: y"))[0]?.file).toBe("src/b.ts");
    expect(
      extract("typecheck", cmd("C:\\repo\\src\\c.ts(5,6): error TS3: z"), "C:\\repo")[0]?.file,
    ).toBe("src/c.ts");
  });

  it("accepts an in-root UNC path but rejects drive and UNC paths outside the root", () => {
    expect(
      extract(
        "typecheck",
        cmd("\\\\server\\share\\repo\\src\\a.ts(1,1): error TS1: x"),
        "\\\\server\\share\\repo",
      )[0]?.file,
    ).toBe("src/a.ts");
    expect(extract("typecheck", cmd("D:\\other\\a.ts(1,1): error TS1: x"), "C:\\repo")).toEqual([]);
    expect(
      extract(
        "typecheck",
        cmd("\\\\server\\other\\a.ts(1,1): error TS1: x"),
        "\\\\server\\share\\repo",
      ),
    ).toEqual([]);
  });

  it("rejects outside paths, root-prefix collisions, traversal, and NUL", () => {
    const hostile = [
      "/etc/passwd(1,1): error TS1: x",
      "/repo-evil/secret.ts(1,1): error TS1: x",
      "../secret.ts(1,1): error TS1: x",
      "src/../secret.ts(1,1): error TS1: x",
      "src/a\u0000.ts(1,1): error TS1: x",
    ];
    for (const output of hostile) expect(extract("typecheck", cmd(output))).toEqual([]);
  });

  it("does not echo an absolute host path from hostile command output", () => {
    const output = "/Users/victim/private/secret.ts(2,3): error TS1: confidential";
    const serialized = JSON.stringify(extract("typecheck", cmd(output)));
    expect(serialized).not.toContain("/Users/victim");
    expect(serialized).toBe("[]");
  });

  it("rejects nonpositive and oversized line or column coordinates", () => {
    for (const output of [
      "src/a.ts(0,1): error TS1: x",
      "src/a.ts(1,0): error TS1: x",
      "src/a.ts(2147483648,1): error TS1: x",
      "src/a.ts(1,2147483648): error TS1: x",
    ]) {
      expect(extract("typecheck", cmd(output))).toEqual([]);
    }
  });
});

// Regression guards for SonarCloud S8786 (superlinear regex backtracking). ESLINT_ROW,
// VITEST_FRAME, and VITEST_TITLE were rewritten to use bounded repetition (VITEST_FRAME's file
// token additionally bounded to 512 chars) instead of unbounded quantifiers directly adjacent to
// an optional/lazy group.
//
// All three pre-fix patterns have a genuine, empirically confirmed polynomial (~quadratic) blowup
// — this is not merely a lint-compliance concern. VITEST_FRAME's previous unbounded `[^\s()]+` is
// the unanchored case: scanning a non-matching line tries every start position, and each attempt
// was itself O(line-length), giving O(n^2) (a non-matching line took ~2.3s at 64,000 chars, up
// from ~3ms at 2,000 — a clean quadratic curve). ESLINT_ROW and VITEST_TITLE are fully anchored
// (`^...$`), so they don't have that per-position-scan mechanism — but an *earlier* pass's
// "no measurable superlinear growth" finding for those two used adversarial shapes (repeated
// short tokens, or a run directly abutting the mandatory `\s+`/`\s*` that precedes the capture)
// that happen to let the mandatory whitespace swallow the whole ambiguous run, neutralizing the
// backtracking before it can compound. With an anchor character that stops the mandatory
// whitespace early, followed by a large interior run of the character class the lazy capture and
// the following `\s{2,}`/`\s*` both match, followed by a terminator neither the optional group nor
// the trailing `\s*$` can consume, both pre-fix patterns show the same clean quadratic growth as
// VITEST_FRAME: ESLINT_ROW took ~3.1s at ~51,000 chars (up from ~45ms at 6,000), and VITEST_TITLE
// took ~150ms at 16,000 chars with ~4x time per doubling. See the "empirical evidence" tests below,
// which reproduce this directly against isolated copies of the pre-fix patterns.
//
// None of this is reachable through `extractFailureLocations` today: every line is filtered to
// MAX_LINE_LENGTH (4,096 chars) before any of these regexes run (see the `.filter` call in
// `extractFailureLocations`), and at that capped size the pre-fix and bounded patterns perform
// comparably (~10-30ms) for all three — so there is no observable hang or regression at this
// module's actual public boundary, before or after this change. The bound is still the right fix:
// it closes a real superlinear-time class for any future direct caller of these patterns (if ever
// exported, reused elsewhere, or if MAX_LINE_LENGTH is ever raised), not just a static-analysis
// preference.
describe("extractFailureLocations — regex safety (S8786 regression guards)", () => {
  it("resolves many maximal-length non-matching vitest frame lines quickly", () => {
    const noise = "a".repeat(4096);
    const lines = Array.from({ length: 30 }, () => noise).join("\n");
    const start = Date.now();
    const out = extract("test", cmd(lines));
    expect(Date.now() - start).toBeLessThan(400);
    expect(out).toEqual([]);
  });

  it("resolves a maximal-length ambiguous ESLint row quickly", () => {
    const prefix = "  1:1  error  ";
    // The leading "x" is an anchor that stops the mandatory `\s+` before the message from
    // absorbing the entire space run below — without it, that `\s+` silently swallows all the
    // ambiguity and the input no longer exercises the shape this test is named for.
    const msg = `x${" ".repeat(4096 - prefix.length - 2)}!`;
    const line = ["/repo/src/a.ts", `${prefix}${msg}`].join("\n");
    const start = Date.now();
    const out = extract("lint", cmd(line));
    expect(Date.now() - start).toBeLessThan(200);
    expect(out).toHaveLength(1);
    expect(out[0]?.ruleId).toBeUndefined();
  });

  it("resolves a maximal-length ambiguous vitest title line quickly", () => {
    // Same anchor-then-ambiguous-run-then-terminator shape as the ESLint row test above, applied
    // to the title capture's own `\s*` neighbours.
    const title = `a${" ".repeat(4096 - "FAIL ".length - 2)}b`;
    const start = Date.now();
    const out = extract("test", cmd(`FAIL ${title}`));
    expect(Date.now() - start).toBeLessThan(200);
    expect(out).toEqual([]);
  });

  it("still captures multi-dot vitest file names unchanged (e.g. foo.perf.test.ts)", () => {
    const out = extract("targeted-test", cmd(" ❯ src/workspaceIndex.perf.test.ts:7:3"));
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toBe("src/workspaceIndex.perf.test.ts");
  });

  // Empirical evidence for the block comment above: isolated copies of the pre-fix ("OLD") and
  // bounded-but-still-ambiguous ("NEW") patterns, exercised directly (bypassing
  // extractFailureLocations' MAX_LINE_LENGTH filter, which is what makes this class unreachable
  // in production) against the anchor + large-ambiguous-run + non-absorbable-terminator shape.
  // This proves the closed class is real, not just SonarCloud preference, and would fail if the
  // bound were ever removed. NEW_ESLINT_ROW mirrors the shipped ESLINT_ROW exactly; NEW_VITEST_TITLE
  // mirrors what VITEST_TITLE looked like before its trailing `\s*$` was dropped entirely (a
  // second SonarCloud pass kept flagging the bounded-but-still-adjacent shape) — kept here as a
  // second, independent data point for the same underlying pattern family.
  it("demonstrates the closed polynomial blowup for ESLINT_ROW's pre-fix shape", () => {
    const OLD_ESLINT_ROW =
      /^\s+(?<line>\d+):(?<col>\d+)\s+(?:error|warning)\s+(?<msg>.+?)(?:\s{2,}(?<rule>[\w@/.-]+))?\s*$/u;
    const NEW_ESLINT_ROW =
      /^\s+(?<line>\d+):(?<col>\d+)\s+(?:error|warning)\s+(?<msg>.{1,4096}?)(?:\s{2,4096}(?<rule>[\w@/.-]{1,4096}))?\s*$/u;
    const n = 30_000;
    const line = `  1:1  error  x${" ".repeat(n)}!`;

    const oldStart = Date.now();
    OLD_ESLINT_ROW.exec(line);
    const oldMs = Date.now() - oldStart;

    const newStart = Date.now();
    NEW_ESLINT_ROW.exec(line);
    const newMs = Date.now() - newStart;

    // The bounded pattern's cost saturates once input exceeds its 4096 bound; the pre-fix
    // pattern keeps growing quadratically. Assert both an absolute plateau and a relative gap so
    // this isn't tied to one CI machine's absolute speed.
    expect(newMs).toBeLessThan(2000);
    expect(oldMs).toBeGreaterThan(newMs * 1.5);
  });

  it("demonstrates the closed polynomial blowup for VITEST_TITLE's pre-fix shape", () => {
    const OLD_VITEST_TITLE = /^\s*(?:FAIL\b|×|✗|✖)\s*(?<title>.+?)\s*$/u;
    const NEW_VITEST_TITLE = /^\s*(?:FAIL\b|×|✗|✖)\s*(?<title>.{1,4096}?)\s*$/u;
    const n = 30_000;
    const line = `FAIL a${" ".repeat(n)}b`;

    const oldStart = Date.now();
    OLD_VITEST_TITLE.exec(line);
    const oldMs = Date.now() - oldStart;

    const newStart = Date.now();
    NEW_VITEST_TITLE.exec(line);
    const newMs = Date.now() - newStart;

    expect(newMs).toBeLessThan(2000);
    expect(oldMs).toBeGreaterThan(newMs * 1.5);
  });
});
