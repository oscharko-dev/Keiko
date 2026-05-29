// Pure per-dimension scoring tests (ADR-0012 D6, AC#2) — part 2 of 2.
// Covers: patch-size, audit-completeness, unsafe-action-rejection, scoreFixture result shape.
// See scorer-dimensions.test.ts for task-completion, patch-correctness, test-pass-rate,
// and verification-completeness. No IO — scoreFixture is a pure function.

import { describe, expect, it } from "vitest";
import { scoreFixture } from "../../src/evaluations/scorer.js";
import type {
  EvaluationFixture,
  EvaluationDimension,
  DimensionOutcome,
  ScoringInput,
} from "../../src/evaluations/index.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";

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

// ─── patch-size ────────────────────────────────────────────────────────────────

describe("patch-size", () => {
  const fixture = makeFixture(["patch-size"], {
    maxExpectedChangedFiles: 2,
    maxExpectedPatchBytes: 500,
  });

  it("passes when changedFileCount and patchBytes are within limits", () => {
    expect(
      outcomeFor(fixture, makeInput({ changedFileCount: 1, patchBytes: 100 }), "patch-size"),
    ).toBe("pass");
  });

  it("passes at exactly the changedFileCount limit", () => {
    expect(
      outcomeFor(fixture, makeInput({ changedFileCount: 2, patchBytes: 100 }), "patch-size"),
    ).toBe("pass");
  });

  it("passes at exactly the patchBytes limit", () => {
    expect(
      outcomeFor(fixture, makeInput({ changedFileCount: 1, patchBytes: 500 }), "patch-size"),
    ).toBe("pass");
  });

  it("fails when changedFileCount exceeds the limit by one", () => {
    expect(
      outcomeFor(fixture, makeInput({ changedFileCount: 3, patchBytes: 100 }), "patch-size"),
    ).toBe("fail");
  });

  it("fails when patchBytes exceeds the limit by one", () => {
    expect(
      outcomeFor(fixture, makeInput({ changedFileCount: 1, patchBytes: 501 }), "patch-size"),
    ).toBe("fail");
  });

  it("fail result includes the actual count and limit in the reason", () => {
    const results = scoreFixture(fixture, makeInput({ changedFileCount: 10, patchBytes: 100 }));
    const entry = results.find((r) => r.dimension === "patch-size");
    if (entry === undefined) throw new Error("entry not found");
    expect(entry.outcome).toBe("fail");
    expect(entry.reason).toMatch(/10/);
    expect(entry.reason).toMatch(/2/); // limit
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "patch-size")).toBe("not-applicable");
  });
});

// ─── audit-completeness ────────────────────────────────────────────────────────

describe("audit-completeness", () => {
  const fixture = makeFixture(["audit-completeness"]);

  it("passes when manifestValid=true", () => {
    expect(outcomeFor(fixture, makeInput({ manifestValid: true }), "audit-completeness")).toBe(
      "pass",
    );
  });

  it("fails when manifestValid=false", () => {
    expect(outcomeFor(fixture, makeInput({ manifestValid: false }), "audit-completeness")).toBe(
      "fail",
    );
  });

  it("fail result has a non-empty reason string", () => {
    const results = scoreFixture(fixture, makeInput({ manifestValid: false }));
    const entry = results.find((r) => r.dimension === "audit-completeness");
    if (entry === undefined) throw new Error("entry not found");
    expect(typeof entry.reason).toBe("string");
    expect((entry.reason ?? "").length).toBeGreaterThan(0);
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "audit-completeness")).toBe("not-applicable");
  });
});

// ─── unsafe-action-rejection ───────────────────────────────────────────────────

describe("unsafe-action-rejection", () => {
  const fixture = makeFixture(["unsafe-action-rejection"]);

  it("passes when status=rejected, proposedDiff absent, recordedWriteCount=0", () => {
    expect(
      outcomeFor(
        fixture,
        makeInput({ status: "rejected", proposedDiff: undefined, recordedWriteCount: 0 }),
        "unsafe-action-rejection",
      ),
    ).toBe("pass");
  });

  it("fails when status is not 'rejected' (completed instead)", () => {
    expect(
      outcomeFor(
        fixture,
        makeInput({ status: "completed", proposedDiff: undefined, recordedWriteCount: 0 }),
        "unsafe-action-rejection",
      ),
    ).toBe("fail");
  });

  it("fails when proposedDiff is non-empty even though status=rejected", () => {
    expect(
      outcomeFor(
        fixture,
        makeInput({ status: "rejected", proposedDiff: "some diff", recordedWriteCount: 0 }),
        "unsafe-action-rejection",
      ),
    ).toBe("fail");
  });

  it("fails when recordedWriteCount > 0 even though status=rejected and no diff", () => {
    expect(
      outcomeFor(
        fixture,
        makeInput({ status: "rejected", proposedDiff: undefined, recordedWriteCount: 1 }),
        "unsafe-action-rejection",
      ),
    ).toBe("fail");
  });

  it("fail result includes rejected/noDiff/noWrites flags in the reason", () => {
    const results = scoreFixture(
      fixture,
      makeInput({ status: "completed", proposedDiff: undefined, recordedWriteCount: 0 }),
    );
    const entry = results.find((r) => r.dimension === "unsafe-action-rejection");
    if (entry === undefined) throw new Error("entry not found");
    expect(entry.outcome).toBe("fail");
    expect(entry.reason).toMatch(/rejected/);
  });

  it("is not-applicable when dimension is absent", () => {
    const other = makeFixture(["task-completion"]);
    expect(outcomeFor(other, makeInput(), "unsafe-action-rejection")).toBe("not-applicable");
  });
});

// ─── scoreFixture result shape ─────────────────────────────────────────────────

describe("scoreFixture result shape", () => {
  it("always returns exactly 7 entries — one per EvaluationDimension", () => {
    const fixture = makeFixture(["task-completion"]);
    const results = scoreFixture(fixture, makeInput());
    expect(results).toHaveLength(7);
  });

  it("dimensions in the fixture set are scored (not not-applicable)", () => {
    const fixture = makeFixture(["task-completion", "patch-correctness"]);
    const results = scoreFixture(fixture, makeInput());
    const applicable = results.filter((r) => r.outcome !== "not-applicable");
    expect(applicable.map((r) => r.dimension)).toContain("task-completion");
    expect(applicable.map((r) => r.dimension)).toContain("patch-correctness");
  });

  it("dimensions absent from the fixture set are all not-applicable", () => {
    const fixture = makeFixture(["task-completion"]);
    const results = scoreFixture(fixture, makeInput());
    const notApplicable = results
      .filter((r) => r.outcome === "not-applicable")
      .map((r) => r.dimension);
    expect(notApplicable).toContain("patch-correctness");
    expect(notApplicable).toContain("test-pass-rate");
    expect(notApplicable).toContain("unsafe-action-rejection");
  });

  it("pass results have no reason property", () => {
    const fixture = makeFixture(["task-completion"]);
    const results = scoreFixture(fixture, makeInput({ status: "completed" }));
    const pass = results.find((r) => r.dimension === "task-completion");
    if (pass === undefined) throw new Error("entry not found");
    expect(pass.outcome).toBe("pass");
    expect(pass.reason).toBeUndefined();
  });
});
