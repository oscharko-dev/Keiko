import { describe, expect, it } from "vitest";
import {
  buildTestGenerationPreview,
  TEST_GENERATION_REVIEW_ACTIONS,
} from "./test-generation-preview.js";
import type { EditorOutputProvenance, EditorTestGenerationResult } from "./types.js";

const PROVENANCE: EditorOutputProvenance = {
  origin: "generated-test",
  model: { modelId: "m", gatewayPolicyVersion: "p", promptHash: "h", producedAt: 1 },
};

function result(): EditorTestGenerationResult {
  return {
    request: { requestId: "r", streamId: "s", sequence: 1 },
    patch: {
      patchId: "patch-1",
      status: "previewed",
      provenance: PROVENANCE,
      changes: [
        {
          uri: "src/a.test.ts",
          isNewFile: true,
          isDeletion: false,
          edits: [
            {
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
              newText:
                "import { it, expect } from 'vitest';\nit('adds', () => expect(1).toBe(1));\n",
            },
          ],
        },
      ],
    },
    provenance: PROVENANCE,
  };
}

describe("buildTestGenerationPreview", () => {
  it("projects the generated candidate into the diff-review model", () => {
    const preview = buildTestGenerationPreview({ result: result(), assurance: "unverified" });
    expect(preview.model.patchId).toBe("patch-1");
    expect(preview.model.files.length).toBe(1);
    expect(preview.assurance).toBe("unverified");
  });

  it("disables apply and run-verification but allows reject (review-first, wave-2 apply)", () => {
    const preview = buildTestGenerationPreview({ result: result(), assurance: "unverified" });
    expect(preview.actions).toBe(TEST_GENERATION_REVIEW_ACTIONS);
    expect(preview.actions.canApply).toBe(false);
    expect(preview.actions.canRunVerification).toBe(false);
    expect(preview.actions.canReject).toBe(true);
  });
});
