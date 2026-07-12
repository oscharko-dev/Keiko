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
import { EDITOR_PROBLEM_MESSAGE_MAX_CHARS } from "@oscharko-dev/keiko-contracts";

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

  it("centrally truncates hostile Unicode messages without leaving a dangling surrogate", () => {
    const hostile = `${"x".repeat(EDITOR_PROBLEM_MESSAGE_MAX_CHARS - 1)}😀${"y".repeat(32)}`;
    const problem = diagnosticToProblem("src/a.ts", diagnostic("error", 0, hostile), 0);
    expect(problem.message.length).toBeLessThanOrEqual(EDITOR_PROBLEM_MESSAGE_MAX_CHARS);
    expect(problem.message.endsWith("\ud83d")).toBe(false);
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

  it("applies the same message bound to verification summaries and locations", () => {
    const hostile = `${"z".repeat(EDITOR_PROBLEM_MESSAGE_MAX_CHARS)}😀tail`;
    const summary = verificationResultToProblems(result({ outputSummary: hostile }));
    const located = verificationResultToProblems(
      result({ locations: [{ file: "src/a.ts", line: 1, message: hostile }] }),
    );
    expect(summary[0]?.message.length).toBeLessThanOrEqual(EDITOR_PROBLEM_MESSAGE_MAX_CHARS);
    expect(located[0]?.message.length).toBeLessThanOrEqual(EDITOR_PROBLEM_MESSAGE_MAX_CHARS);
  });
});

describe("editorProblemsStore aggregation", () => {
  it("aggregates pane diagnostics and the latest report, notifying subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEditorProblems("/ws", listener);
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [diagnostic("error", 0)]);
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
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [diagnostic("error", 0)]);
    expect(getEditorProblems("/ws")).toHaveLength(1);
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", []);
    expect(getEditorProblems("/ws")).toHaveLength(0);
  });

  it("scopes diagnostics per project root — two projects sharing a relative path do not collide (Epic #2092 fix-up)", () => {
    setPaneDiagnostics("/ws-a", "window-a", "src/index.ts", [
      diagnostic("error", 0, "project A error"),
    ]);
    setPaneDiagnostics("/ws-b", "window-b", "src/index.ts", [
      diagnostic("warning", 0, "project B warning"),
    ]);
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
    setPaneDiagnostics("/ws-a", "window-a", "src/a.ts", [diagnostic("error", 0)]);
    expect(listenerA).toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it("keeps another producer's same-path diagnostics when one window cleans up", () => {
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [diagnostic("error", 0, "shared")]);
    setPaneDiagnostics("/ws", "window-b", "src/a.ts", [diagnostic("error", 0, "shared")]);
    expect(getEditorProblems("/ws")).toHaveLength(1);

    setPaneDiagnostics("/ws", "window-a", "src/a.ts", []);

    expect(getEditorProblems("/ws")).toHaveLength(1);
    expect(getEditorProblems("/ws")[0]?.message).toBe("shared");
  });

  it("deduplicates producers deterministically regardless of update order", () => {
    const shared = diagnostic("error", 0, "same problem");
    setPaneDiagnostics("/ws", "window-z", "src/a.ts", [shared]);
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [shared]);
    const first = getEditorProblems("/ws");
    resetEditorProblemsStoreForTests();
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [shared]);
    setPaneDiagnostics("/ws", "window-z", "src/a.ts", [shared]);
    expect(getEditorProblems("/ws")).toEqual(first);
  });

  it("orders producer and path keys with an explicit Unicode-aware collation", () => {
    const shared = diagnostic("error", 0, "same problem");
    setPaneDiagnostics("/ws", "z-window", "src/shared.ts", [shared]);
    setPaneDiagnostics("/ws", "ä-window", "src/shared.ts", [shared]);
    setPaneDiagnostics("/ws", "paths", "src/z.ts", [diagnostic("error", 0, "z")]);
    setPaneDiagnostics("/ws", "paths", "src/ä.ts", [diagnostic("error", 0, "umlaut")]);

    const problems = getEditorProblems("/ws");
    expect(problems.map((problem) => problem.file)).toEqual([
      "src/shared.ts",
      "src/ä.ts",
      "src/z.ts",
    ]);
    expect(problems[0]?.id).toContain(":z-window:");
  });
});
