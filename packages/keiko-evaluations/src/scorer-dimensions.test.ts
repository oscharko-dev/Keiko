// Pure per-dimension scoring tests (ADR-0012 D6, AC#2) — part 1 of 2.
// Covers: task-completion, patch-correctness, test-pass-rate, verification-completeness.
// See scorer-dimensions-2.test.ts for patch-size, audit-completeness, unsafe-action-rejection,
// and scoreFixture result shape. No IO — scoreFixture is a pure function.

import { describe, expect, it } from "vitest";
import { scoreFixture } from "./scorer.js";
import type {
  EvaluationFixture,
  EvaluationDimension,
  DimensionOutcome,
  ScoringInput,
} from "./index.js";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

// ─── Test helpers ───────────────────────────────────────────────────────────────

function makeResponse(): NormalizedResponse {
  return {
    modelId: "m",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

function makeFixture(
  dimensions: readonly EvaluationDimension[],
  oracle: Partial<EvaluationFixture["oracle"]> = {},
): EvaluationFixture {
  return {
    name: "test-fixture",
    workflowKind: "unit-tests",
    workspaceFiles: { "package.json": "{}" },
    workflowInput: { target: { kind: "file", filePath: "src/x.ts" } },
    mockTranscript: [makeResponse()],
    dimensions: new Set(dimensions),
    oracle: {
      expectedStatuses: ["completed"],
      expectPatch: true,
      expectVerificationSkip: false,
      maxExpectedChangedFiles: 5,
      maxExpectedPatchBytes: 10_000,
      ...oracle,
    },
  };
}

function makeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    status: "completed",
    proposedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
    changedFileCount: 1,
    patchBytes: 100,
    verificationStatus: "passed",
    verificationPresent: true,
    manifestValid: true,
    recordedWriteCount: 0,
    mode: "offline",
    ...overrides,
  };
}

function outcomeFor(
  fixture: EvaluationFixture,
  input: ScoringInput,
  dimension: EvaluationDimension,
): DimensionOutcome {
  const results = scoreFixture(fixture, input);
  const entry = results.find((r) => r.dimension === dimension);
  if (entry === undefined) throw new Error(`dimension ${dimension} not found in results`);
  return entry.outcome;
}

// ─── task-completion ───────────────────────────────────────────────────────────

describe("task-completion", () => {
  const fixture = makeFixture(["task-completion"]);

  it("passes when status is 'completed'", () => {
    expect(outcomeFor(fixture, makeInput({ status: "completed" }), "task-completion")).toBe("pass");
  });

  it("passes when status is in the fixture oracle's expectedStatuses", () => {
    const statusFixture = makeFixture(["task-completion"], {
      expectedStatuses: ["dry-run", "fix-applied", "fix-proposed", "investigation-only"],
    });
    for (const status of ["dry-run", "fix-applied", "fix-proposed", "investigation-only"]) {
      expect(outcomeFor(statusFixture, makeInput({ status }), "task-completion")).toBe("pass");
    }
  });

  it("fails when status is a success terminal outside the fixture oracle", () => {
    expect(outcomeFor(fixture, makeInput({ status: "dry-run" }), "task-completion")).toBe("fail");
  });

  it("fails when status is 'rejected'", () => {
    expect(outcomeFor(fixture, makeInput({ status: "rejected" }), "task-completion")).toBe("fail");
  });

  it("fails when status is 'failed'", () => {
    expect(outcomeFor(fixture, makeInput({ status: "failed" }), "task-completion")).toBe("fail");
  });

  it("fails when status is 'cancelled'", () => {
    expect(outcomeFor(fixture, makeInput({ status: "cancelled" }), "task-completion")).toBe("fail");
  });

  it("fail result includes a reason string", () => {
    const results = scoreFixture(fixture, makeInput({ status: "failed" }));
    const entry = results.find((r) => r.dimension === "task-completion");
    if (entry === undefined) throw new Error("entry not found");
    expect(entry.outcome).toBe("fail");
    expect(typeof entry.reason).toBe("string");
    expect((entry.reason ?? "").length).toBeGreaterThan(0);
  });

  it("is not-applicable when dimension is absent from the fixture set", () => {
    const noTask = makeFixture(["patch-correctness"]);
    expect(outcomeFor(noTask, makeInput(), "task-completion")).toBe("not-applicable");
  });
});

// ─── patch-correctness ─────────────────────────────────────────────────────────

describe("patch-correctness", () => {
  const fixture = makeFixture(["patch-correctness"], { expectPatch: true });
  const noPatchFixture = makeFixture(["patch-correctness"], { expectPatch: false });

  it("passes when expectPatch=true and proposedDiff is non-empty", () => {
    expect(
      outcomeFor(fixture, makeInput({ proposedDiff: "diff content" }), "patch-correctness"),
    ).toBe("pass");
  });

  it("fails when expectPatch=true but proposedDiff is undefined", () => {
    expect(outcomeFor(fixture, makeInput({ proposedDiff: undefined }), "patch-correctness")).toBe(
      "fail",
    );
  });

  it("fails when expectPatch=true but proposedDiff is empty string", () => {
    expect(outcomeFor(fixture, makeInput({ proposedDiff: "" }), "patch-correctness")).toBe("fail");
  });

  it("passes when expectPatch=false and proposedDiff is absent", () => {
    expect(
      outcomeFor(noPatchFixture, makeInput({ proposedDiff: undefined }), "patch-correctness"),
    ).toBe("pass");
  });

  it("fails when expectPatch=false but proposedDiff is non-empty", () => {
    expect(
      outcomeFor(
        noPatchFixture,
        makeInput({ proposedDiff: "unexpected diff" }),
        "patch-correctness",
      ),
    ).toBe("fail");
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "patch-correctness")).toBe("not-applicable");
  });
});

// ─── test-pass-rate ────────────────────────────────────────────────────────────

describe("test-pass-rate", () => {
  const fixture = makeFixture(["test-pass-rate"]);

  it("passes when verificationStatus is 'passed'", () => {
    expect(outcomeFor(fixture, makeInput({ verificationStatus: "passed" }), "test-pass-rate")).toBe(
      "pass",
    );
  });

  it("fails when verificationStatus is 'failed'", () => {
    expect(outcomeFor(fixture, makeInput({ verificationStatus: "failed" }), "test-pass-rate")).toBe(
      "fail",
    );
  });

  it("fails when verificationStatus is undefined (no verification ran)", () => {
    expect(
      outcomeFor(fixture, makeInput({ verificationStatus: undefined }), "test-pass-rate"),
    ).toBe("fail");
  });

  it("fails when verificationStatus is any non-'passed' string", () => {
    expect(
      outcomeFor(fixture, makeInput({ verificationStatus: "skipped" }), "test-pass-rate"),
    ).toBe("fail");
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "test-pass-rate")).toBe("not-applicable");
  });
});

// ─── verification-completeness ─────────────────────────────────────────────────

describe("verification-completeness", () => {
  const fixture = makeFixture(["verification-completeness"], { expectVerificationSkip: false });
  const skipFixture = makeFixture(["verification-completeness"], { expectVerificationSkip: true });

  it("passes when verificationPresent=true and expectVerificationSkip=false", () => {
    expect(
      outcomeFor(fixture, makeInput({ verificationPresent: true }), "verification-completeness"),
    ).toBe("pass");
  });

  it("fails when verificationPresent=false and expectVerificationSkip=false", () => {
    expect(
      outcomeFor(fixture, makeInput({ verificationPresent: false }), "verification-completeness"),
    ).toBe("fail");
  });

  it("passes when expectVerificationSkip=true regardless of verificationPresent", () => {
    expect(
      outcomeFor(
        skipFixture,
        makeInput({ verificationPresent: false }),
        "verification-completeness",
      ),
    ).toBe("pass");
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "verification-completeness")).toBe("not-applicable");
  });
});
