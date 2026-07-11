import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationResult } from "@oscharko-dev/keiko-contracts";
import type { EditorDiagnostic } from "@oscharko-dev/keiko-editor";
import {
  diagnosticToProblem,
  getEditorProblems,
  resetEditorProblemsStoreForTests,
  setPaneDiagnostics,
  setVerificationReport,
  subscribeEditorProblems,
  verificationResultToProblems,
} from "./editorProblemsStore";

function diagnostic(
  severity: EditorDiagnostic["severity"],
  line: number,
  message = "boom",
): EditorDiagnostic {
  return {
    range: { start: { line, column: 2 }, end: { line, column: 4 } },
    severity,
    message,
  };
}

function result(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    kind: "typecheck",
    scriptName: "typecheck",
    command: "npm",
    args: [],
    status: "failed",
    exitCode: 2,
    signal: null,
    durationMs: 1,
    truncated: false,
    redacted: true,
    outputSummary: "digest",
    appliedLimits: [],
    ...over,
  };
}

afterEach(() => {
  resetEditorProblemsStoreForTests();
});

describe("diagnosticToProblem", () => {
  it("normalizes hint to info and converts zero-based range to a 1-based location", () => {
    const problem = diagnosticToProblem("src/a.ts", diagnostic("hint", 11), 0);
    expect(problem.severity).toBe("info");
    expect(problem.source).toBe("language-diagnostic");
    expect(problem.file).toBe("src/a.ts");
    expect(problem.line).toBe(12); // 11 (0-based) + 1
    expect(problem.column).toBe(3); // 2 (0-based) + 1
    expect(problem.kind).toBe("language-diagnostic");
  });

  it("keeps error/warning severities", () => {
    expect(diagnosticToProblem("f", diagnostic("error", 0), 0).severity).toBe("error");
    expect(diagnosticToProblem("f", diagnostic("warning", 0), 0).severity).toBe("warning");
  });
});

describe("verificationResultToProblems", () => {
  it("returns nothing for a non-failed result", () => {
    expect(verificationResultToProblems(result({ status: "passed" }))).toEqual([]);
  });

  it("maps each structured location to an error problem", () => {
    const problems = verificationResultToProblems(
      result({
        kind: "typecheck",
        locations: [{ file: "src/a.ts", line: 3, column: 5, message: "TS2322" }],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      severity: "error",
      source: "verification",
      file: "src/a.ts",
      line: 3,
      kind: "typecheck",
    });
  });

  it("emits ONE bounded summary row (no location) for an unmappable failure", () => {
    const problems = verificationResultToProblems(result({ kind: "build", outputSummary: "boom" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBeUndefined();
    expect(problems[0]?.message).toBe("boom");
    expect(problems[0]?.source).toBe("verification");
  });
});

describe("editorProblemsStore aggregation", () => {
  it("aggregates pane diagnostics and the latest report, notifying subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEditorProblems("/ws", listener);
    setPaneDiagnostics("/ws", "src/a.ts", [diagnostic("error", 0)]);
    setVerificationReport("/ws", {
      workspaceRoot: "/ws",
      results: [result({ locations: [{ file: "src/b.ts", line: 9, message: "x" }] })],
      overallStatus: "failed",
      startedAtMs: 1,
      durationMs: 2,
      counts: {
        passed: 0,
        failed: 1,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
    });
    const files = getEditorProblems("/ws").map((p) => p.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("removes a pane's diagnostics when it closes (open-files-only scoping)", () => {
    setPaneDiagnostics("/ws", "src/a.ts", [diagnostic("error", 0)]);
    expect(getEditorProblems("/ws")).toHaveLength(1);
    setPaneDiagnostics("/ws", "src/a.ts", []);
    expect(getEditorProblems("/ws")).toHaveLength(0);
  });

  it("scopes diagnostics per project root — two projects sharing a relative path do not collide (Epic #2092 fix-up)", () => {
    setPaneDiagnostics("/ws-a", "src/index.ts", [diagnostic("error", 0, "project A error")]);
    setPaneDiagnostics("/ws-b", "src/index.ts", [diagnostic("warning", 0, "project B warning")]);
    expect(getEditorProblems("/ws-a")).toHaveLength(1);
    expect(getEditorProblems("/ws-a")[0]?.message).toBe("project A error");
    expect(getEditorProblems("/ws-b")).toHaveLength(1);
    expect(getEditorProblems("/ws-b")[0]?.message).toBe("project B warning");
  });

  it("does not notify a different project's subscriber (Epic #2092 fix-up)", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    subscribeEditorProblems("/ws-a", listenerA);
    subscribeEditorProblems("/ws-b", listenerB);
    setPaneDiagnostics("/ws-a", "src/a.ts", [diagnostic("error", 0)]);
    expect(listenerA).toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
  });
});
