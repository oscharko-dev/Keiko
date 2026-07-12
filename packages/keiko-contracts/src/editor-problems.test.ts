import { describe, expect, it } from "vitest";
import {
  EDITOR_PROBLEMS_PER_FILE_CAP,
  EDITOR_PROBLEMS_SCHEMA_VERSION,
  EDITOR_PROBLEMS_TOTAL_CAP,
  buildEditorProblemsSnapshot,
  compareEditorProblems,
  isEditorProblem,
  isEditorProblemsSnapshot,
  isEditorProblemSeverity,
  isEditorProblemSource,
  type EditorProblem,
} from "./editor-problems.js";

function problem(over: Partial<EditorProblem> = {}): EditorProblem {
  return {
    id: "p1",
    severity: "error",
    source: "verification",
    file: "src/a.ts",
    line: 1,
    column: 1,
    message: "boom",
    kind: "typecheck",
    ...over,
  };
}

describe("compareEditorProblems", () => {
  it("orders by severity descending (error, warning, info)", () => {
    const input = [
      problem({ id: "i", severity: "info" }),
      problem({ id: "e", severity: "error" }),
      problem({ id: "w", severity: "warning" }),
    ];
    const ordered = [...input].sort(compareEditorProblems).map((p) => p.id);
    expect(ordered).toEqual(["e", "w", "i"]);
  });

  it("breaks a severity tie by file path ascending", () => {
    const input = [problem({ id: "b", file: "src/b.ts" }), problem({ id: "a", file: "src/a.ts" })];
    const ordered = [...input].sort(compareEditorProblems).map((p) => p.id);
    expect(ordered).toEqual(["a", "b"]);
  });

  it("breaks a severity+file tie by line ascending, missing line sorting last", () => {
    const input = [
      problem({ id: "none", line: undefined, column: undefined }),
      problem({ id: "l9", line: 9 }),
      problem({ id: "l2", line: 2 }),
    ];
    const ordered = [...input].sort(compareEditorProblems).map((p) => p.id);
    expect(ordered).toEqual(["l2", "l9", "none"]);
  });

  it("is a deterministic total order when severity, file, and line all tie (explicit tie-break)", () => {
    // Same severity, same file, same line — resolved by column, then source, then message, then id.
    // Asserted explicitly rather than relying on the sort's stability.
    const a = problem({ id: "z", column: 1, source: "language-diagnostic", message: "aaa" });
    const b = problem({ id: "a", column: 1, source: "language-diagnostic", message: "aaa" });
    const c = problem({ id: "m", column: 1, source: "verification", message: "aaa" });
    const forward = [a, b, c].sort(compareEditorProblems).map((p) => p.id);
    const reversed = [c, b, a].sort(compareEditorProblems).map((p) => p.id);
    // language-diagnostic < verification (source), then id ascending among the two diagnostics.
    expect(forward).toEqual(["a", "z", "m"]);
    expect(reversed).toEqual(forward);
    expect(compareEditorProblems(a, a)).toBe(0);
  });
});

describe("buildEditorProblemsSnapshot", () => {
  it("returns an unbounded snapshot when caps are not exceeded", () => {
    const snapshot = buildEditorProblemsSnapshot([problem({ id: "x" })]);
    expect(snapshot.schemaVersion).toBe(EDITOR_PROBLEMS_SCHEMA_VERSION);
    expect(snapshot.totalCount).toBe(1);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.problems).toHaveLength(1);
    expect(snapshot.perFileCap).toBe(EDITOR_PROBLEMS_PER_FILE_CAP);
    expect(snapshot.totalCap).toBe(EDITOR_PROBLEMS_TOTAL_CAP);
  });

  it("honors the per-file cap and flags truncation, keeping the true totalCount", () => {
    const many = Array.from({ length: 5 }, (_unused, index) =>
      problem({ id: `f${String(index)}`, file: "src/same.ts", line: index + 1 }),
    );
    const snapshot = buildEditorProblemsSnapshot(many, 2, 100);
    expect(snapshot.problems).toHaveLength(2);
    expect(snapshot.totalCount).toBe(5);
    expect(snapshot.truncated).toBe(true);
    // Lowest lines survive (sorted first).
    expect(snapshot.problems.map((p) => p.line)).toEqual([1, 2]);
  });

  it("honors the total cap across files and flags truncation", () => {
    const across = [
      problem({ id: "a", file: "src/a.ts" }),
      problem({ id: "b", file: "src/b.ts" }),
      problem({ id: "c", file: "src/c.ts" }),
    ];
    const snapshot = buildEditorProblemsSnapshot(across, 100, 2);
    expect(snapshot.problems).toHaveLength(2);
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.truncated).toBe(true);
  });

  it("produces a snapshot that satisfies its own guard", () => {
    const snapshot = buildEditorProblemsSnapshot([problem()]);
    expect(isEditorProblemsSnapshot(snapshot)).toBe(true);
  });
});

describe("editor-problems guards", () => {
  it("accepts a valid problem and rejects malformed ones", () => {
    expect(isEditorProblem(problem())).toBe(true);
    expect(isEditorProblem(problem({ line: 0 }))).toBe(false); // line must be 1-based positive
    expect(isEditorProblem({ ...problem(), severity: "hint" })).toBe(false);
    expect(isEditorProblem({ ...problem(), kind: "not-a-kind" })).toBe(false);
    expect(isEditorProblem({ ...problem(), file: "" })).toBe(false);
    expect(isEditorProblem(null)).toBe(false);
  });

  it("accepts a verification-kind origin and the language-diagnostic marker", () => {
    expect(isEditorProblem(problem({ kind: "lint", source: "verification" }))).toBe(true);
    expect(
      isEditorProblem(problem({ kind: "language-diagnostic", source: "language-diagnostic" })),
    ).toBe(true);
  });

  it("validates the severity and source enums", () => {
    expect(isEditorProblemSeverity("warning")).toBe(true);
    expect(isEditorProblemSeverity("hint")).toBe(false);
    expect(isEditorProblemSource("verification")).toBe(true);
    expect(isEditorProblemSource("other")).toBe(false);
  });

  it("rejects a snapshot with a bad problem or non-integer caps", () => {
    const base = buildEditorProblemsSnapshot([problem()]);
    expect(isEditorProblemsSnapshot({ ...base, perFileCap: 0 })).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, problems: [{ bad: true }] })).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, totalCount: -1 })).toBe(false);
  });

  it("enforces list, per-file, and configured cap relationships", () => {
    const base = buildEditorProblemsSnapshot([problem({ id: "a" }), problem({ id: "b" })], 2, 2);
    expect(
      isEditorProblemsSnapshot({ ...base, problems: [...base.problems, problem({ id: "c" })] }),
    ).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, perFileCap: 1 })).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, totalCap: EDITOR_PROBLEMS_TOTAL_CAP + 1 })).toBe(
      false,
    );
    expect(
      isEditorProblemsSnapshot({ ...base, perFileCap: EDITOR_PROBLEMS_PER_FILE_CAP + 1 }),
    ).toBe(false);
  });

  it("requires totalCount and truncated to describe the visible list honestly", () => {
    const base = buildEditorProblemsSnapshot([problem()]);
    expect(isEditorProblemsSnapshot({ ...base, totalCount: 0 })).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, totalCount: 2, truncated: false })).toBe(false);
    expect(isEditorProblemsSnapshot({ ...base, truncated: true })).toBe(false);
  });

  it("rejects hostile oversized and sparse arrays before iterating their contents", () => {
    const base = buildEditorProblemsSnapshot([]);
    const oversized = Array.from({ length: EDITOR_PROBLEMS_TOTAL_CAP + 1 }, (_unused, index) =>
      problem({ id: String(index), file: `src/${String(index)}.ts` }),
    );
    expect(
      isEditorProblemsSnapshot({
        ...base,
        problems: oversized,
        totalCount: oversized.length,
        truncated: false,
      }),
    ).toBe(false);
    expect(
      isEditorProblemsSnapshot({
        ...base,
        problems: new Array(1),
        totalCount: 1,
        truncated: false,
      }),
    ).toBe(false);
  });

  it("rejects non-canonical problem paths, source/kind mismatches, and extra fields", () => {
    expect(isEditorProblem(problem({ file: "/host/a.ts" }))).toBe(false);
    expect(isEditorProblem(problem({ file: "src\\a.ts" }))).toBe(false);
    expect(isEditorProblem(problem({ source: "verification", kind: "language-diagnostic" }))).toBe(
      false,
    );
    expect(isEditorProblem(problem({ source: "language-diagnostic", kind: "lint" }))).toBe(false);
    expect(isEditorProblem({ ...problem(), raw: "secret" })).toBe(false);
  });
});
