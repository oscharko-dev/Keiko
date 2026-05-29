// Bug-investigation investigation-only fixture (ADR-0012 D3): the model returns a root-cause
// hypothesis with NO fenced diff block. The workflow produces zero patch bytes and terminates
// `investigation-only` with a non-empty hypothesis.rootCause — the bounded "no invented fix when
// evidence is thin" outcome (ADR-0009 D10). patch-correctness is not-applicable (expectPatch: false).

import { scriptedResponse } from "../support.js";
import type { EvaluationFixture } from "../../types.js";

const MODEL_CONTENT = [
  "## Root cause",
  "The failure points at a race in the cache layer, but the evidence is insufficient to localize a",
  "single line, so no fix is proposed.",
  "## Uncertainty",
  "The stack trace does not include the cache module frames.",
  "## Confidence",
  "low",
].join("\n");

export const bugInvestigationOnly: EvaluationFixture = {
  name: "investigation-only",
  workflowKind: "bug-investigation",
  workspaceFiles: {
    "package.json": JSON.stringify(
      { name: "eval-fixture", version: "0.0.0", type: "module" },
      null,
      2,
    ),
    "src/cache.ts": "export const get = (k: string): string | undefined => store.get(k);\n",
    "tests/.gitkeep": "",
  },
  workflowInput: {
    report: {
      description: "intermittent cache miss under load",
      failingOutput: "Error: expected hit but got miss",
    },
    modelId: "eval-model",
  },
  mockTranscript: [scriptedResponse(MODEL_CONTENT)],
  dimensions: new Set(["task-completion", "patch-correctness", "audit-completeness"]),
  oracle: {
    expectedStatuses: ["investigation-only"],
    expectPatch: false,
    expectVerificationSkip: true,
    maxExpectedChangedFiles: 0,
    maxExpectedPatchBytes: 0,
  },
};
