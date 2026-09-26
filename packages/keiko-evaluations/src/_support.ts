// Shared test helpers for evaluation tests. Not a *.test.ts so vitest does not collect it.

import { scoreFixture } from "./scorer.js";
import type {
  DimensionOutcome,
  EvaluationDimension,
  EvaluationFixture,
  EvaluationMode,
  ScoringInput,
} from "./index.js";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

export function must<T>(value: T | undefined, message = "expected a defined value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// KEIKO-0917: shared scorer-dimensions test builders, previously duplicated verbatim between
// scorer-dimensions.test.ts and scorer-dimensions-2.test.ts (the two files are a deliberate LOC-limit
// split of one original test file; only the shared fixture/input builders move here).
export function makeResponse(): NormalizedResponse {
  return {
    modelId: "m",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

export function makeFixture(
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

export function makeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
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

export function makeInputForMode(
  mode: EvaluationMode,
  overrides: Partial<ScoringInput> = {},
): ScoringInput {
  return makeInput({ mode, ...overrides });
}

export function outcomeFor(
  fixture: EvaluationFixture,
  input: ScoringInput,
  dimension: EvaluationDimension,
): DimensionOutcome {
  const results = scoreFixture(fixture, input);
  const entry = results.find((r) => r.dimension === dimension);
  if (entry === undefined) throw new Error(`dimension ${dimension} not found in results`);
  return entry.outcome;
}
