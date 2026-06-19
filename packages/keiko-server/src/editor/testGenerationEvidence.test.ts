import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  notRunTestGenerationFunnel,
  type EditorTestGenerationWireResponse,
} from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";
import {
  recordTestGenerationEvidence,
  testGenerationEvidenceRunId,
} from "./testGenerationEvidence.js";

const REDACTOR: Redactor = (value) => value;

function disabled(): EditorTestGenerationWireResponse {
  return {
    schemaVersion: "1",
    status: "disabled",
    reason: "off",
    funnel: notRunTestGenerationFunnel(),
  };
}

function generated(): EditorTestGenerationWireResponse {
  return {
    schemaVersion: "1",
    status: "generated",
    assurance: "unverified",
    funnel: { ...notRunTestGenerationFunnel(), candidatesGenerated: 1, candidatesSurfaced: 1 },
    patch: {
      patchId: "p1",
      files: [
        {
          path: "src/a.test.ts",
          changeKind: "added",
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "SECRET_TEST_BODY_SHOULD_NOT_PERSIST",
            },
          ],
        },
      ],
    },
    provenance: { modelId: "m", gatewayPolicyVersion: "v", promptHash: "h", producedAt: 1 },
  };
}

describe("recordTestGenerationEvidence", () => {
  it("persists a content-free manifest for a disabled outcome", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordTestGenerationEvidence(store, REDACTOR, disabled(), 1_000);
    const raw = store.get(runId);
    expect(raw).toBeDefined();
    const manifest = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    expect(manifest.status).toBe("disabled");
    expect(manifest.fileCount).toBe(0);
    expect(manifest.modelId).toBeUndefined();
  });

  it("records provenance + file count for a generated outcome without the candidate body", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordTestGenerationEvidence(store, REDACTOR, generated(), 1_000);
    const raw = store.get(runId) ?? "";
    expect(raw).not.toContain("SECRET_TEST_BODY_SHOULD_NOT_PERSIST");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest.assurance).toBe("unverified");
    expect(manifest.fileCount).toBe(1);
    expect(manifest.modelId).toBe("m");
  });

  it("derives a deterministic, content-free run id", () => {
    expect(testGenerationEvidenceRunId(disabled(), 1_000)).toBe(
      testGenerationEvidenceRunId(disabled(), 1_000),
    );
    expect(testGenerationEvidenceRunId(disabled(), 1_000)).toMatch(/^editor-test-generation-/);
  });
});
