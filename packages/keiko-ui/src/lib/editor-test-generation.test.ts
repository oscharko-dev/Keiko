import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorRequestIdentity } from "@oscharko-dev/keiko-editor";
import { requestEditorTestGeneration } from "./api";
import { mapWireToEditorTestGenerationOutcome } from "./editor-test-generation";
import type { EditorTestGenerationWireResponse } from "./types";

const REQUEST: EditorRequestIdentity = { requestId: "r1", streamId: "s", sequence: 1 };

const NOT_RUN_FUNNEL = {
  executionEnabled: false,
  candidatesGenerated: 0,
  candidatesSurfaced: 0,
  stabilityRunsRequired: 5,
  build: "not-run",
  pass: "not-run",
  stability: "not-run",
  coverage: "not-run",
  mutation: "not-run",
  antiTautology: "not-run",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestEditorTestGeneration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the target to the test-generation route with the CSRF header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          schemaVersion: "1",
          status: "disabled",
          reason: "off",
          funnel: NOT_RUN_FUNNEL,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const response = await requestEditorTestGeneration({
      root: "/repo",
      target: {
        kind: "file",
        document: { path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" },
      },
      contextBudgetBytes: 65_536,
    });
    expect(response.status).toBe("disabled");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/test-generation",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });
});

describe("mapWireToEditorTestGenerationOutcome", () => {
  it("maps disabled / failed / deferred outcomes with content-free reasons", () => {
    const disabled = mapWireToEditorTestGenerationOutcome(REQUEST, {
      schemaVersion: "1",
      status: "disabled",
      reason: "off",
      funnel: NOT_RUN_FUNNEL,
    });
    expect(disabled.status).toBe("disabled");

    const deferred = mapWireToEditorTestGenerationOutcome(REQUEST, {
      schemaVersion: "1",
      status: "deferred",
      reason: "wave 2",
      funnel: NOT_RUN_FUNNEL,
      context: {
        schemaVersion: "1",
        purpose: "test-generation",
        entries: [],
        usedBytes: 0,
        budgetBytes: 0,
        droppedForBudget: 0,
        omissions: [],
      },
    });
    expect(deferred.status).toBe("deferred");
    if (deferred.status === "deferred") {
      expect(deferred.context?.entries).toEqual([]);
    }
  });

  it("maps a generated outcome into a reviewable editor patch with generated-test provenance", () => {
    const wire: EditorTestGenerationWireResponse = {
      schemaVersion: "1",
      status: "generated",
      assurance: "unverified",
      funnel: { ...NOT_RUN_FUNNEL, candidatesGenerated: 1, candidatesSurfaced: 1 },
      patch: {
        patchId: "p1",
        files: [
          {
            path: "src/a.test.ts",
            changeKind: "added",
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "it('adds', () => {});\n",
              },
            ],
          },
        ],
      },
      provenance: { modelId: "m", gatewayPolicyVersion: "v", promptHash: "h", producedAt: 7 },
    };
    const outcome = mapWireToEditorTestGenerationOutcome(REQUEST, wire);
    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.assurance).toBe("unverified");
      const change = outcome.result.patch.changes[0];
      expect(change?.uri).toBe("src/a.test.ts");
      expect(change?.isNewFile).toBe(true);
      expect(change?.edits[0]?.range.start.column).toBe(0);
      expect(outcome.result.provenance.origin).toBe("generated-test");
    }
  });

  it("falls back to failed when a generated response is missing its patch", () => {
    const outcome = mapWireToEditorTestGenerationOutcome(REQUEST, {
      schemaVersion: "1",
      status: "generated",
      funnel: NOT_RUN_FUNNEL,
    });
    expect(outcome.status).toBe("failed");
  });
});
