// Issue #1387 — command-run evidence builder tests. The manifest is content-free: counts and enums
// only, never the run argv or output. Mirrors terminal-evidence coverage.

import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { CommandFailureReason } from "@oscharko-dev/keiko-contracts";
import {
  appendCommandRunEvidence,
  buildCommandRunEvidenceEntry,
  type CommandRunEvidenceInput,
} from "./command-runner-evidence.js";

function baseInput(overrides: Partial<CommandRunEvidenceInput> = {}): CommandRunEvidenceInput {
  return {
    runId: "run-1",
    projectId: "/work/project",
    taskId: "npm-script:test",
    kind: "test",
    executable: "npm",
    argCount: 2,
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    truncated: false,
    failureReason: "none",
    stdoutBytes: 4,
    stderrBytes: 0,
    startedAt: 1700000000000,
    ...overrides,
  };
}

describe("buildCommandRunEvidenceEntry", () => {
  it("builds a content-free manifest with identifiers and counts only", () => {
    const entry = buildCommandRunEvidenceEntry(baseInput());
    expect(entry.run.taskType).toBe("command-run");
    expect(entry.run.runId).toBe("run-1");
    expect(entry.run.finishedAt).toBe(1700000000012);
    expect(entry.commandExecutions).toEqual([
      {
        seq: 1,
        ts: 1700000000000,
        executable: "npm",
        argCount: 2,
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
      },
    ]);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("run test");
    expect(serialized).not.toContain("vitest");
  });

  it("maps failure reasons to run outcomes", () => {
    const cases: readonly [CommandFailureReason, string][] = [
      ["none", "completed"],
      ["non-zero-exit", "failed"],
      ["timed-out", "limit-exceeded"],
      ["cancelled", "cancelled"],
      ["denied", "failed"],
      ["spawn-error", "failed"],
    ];
    for (const [failureReason, outcome] of cases) {
      const entry = buildCommandRunEvidenceEntry(baseInput({ failureReason, exitCode: null }));
      expect(entry.run.outcome).toBe(outcome);
    }
  });
});

describe("appendCommandRunEvidence", () => {
  it("redacts every string leaf before persisting", () => {
    const store = createInMemoryEvidenceStore();
    appendCommandRunEvidence(
      store,
      buildCommandRunEvidenceEntry(baseInput({ executable: "npm-SECRET" })),
      (value) => value.replace("SECRET", "[REDACTED]"),
    );
    const raw = store.get("run-1");
    expect(raw).toContain("npm-[REDACTED]");
    expect(raw).not.toContain("npm-SECRET");
  });
});
