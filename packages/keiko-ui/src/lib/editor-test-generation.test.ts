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

const CONTEXT_SOURCE_CASES = [
  { sourceKind: "repo-search", sourceTier: "first-party-workspace" },
  { sourceKind: "connected-context", sourceTier: "first-party-workspace" },
  { sourceKind: "local-knowledge", sourceTier: "indexed-knowledge" },
  { sourceKind: "memory", sourceTier: "retained-memory" },
  { sourceKind: "quality-intelligence", sourceTier: "derived-evidence" },
  { sourceKind: "workflow-context", sourceTier: "derived-evidence" },
  { sourceKind: "files-focus", sourceTier: "first-party-workspace" },
  { sourceKind: "editor-state", sourceTier: "first-party-workspace" },
] as const;

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
    const fetchMock = vi.fn().mockResolvedValue(
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

  it("preserves editor-state source/tier and the existing context provenance values", () => {
    const entries = CONTEXT_SOURCE_CASES.map((source, index) => ({
      ...source,
      id: `context-${String(index)}`,
      score: 1 - index * 0.05,
      rank: index,
      citationRef: `citation-${String(index)}`,
      byteCount: index + 1,
      truncated: false,
    }));
    const omissions = [
      { sourceKind: "files-focus", reason: "not-ready" },
      { sourceKind: "editor-state", reason: "out-of-budget" },
    ] as const;
    const outcome = mapWireToEditorTestGenerationOutcome(REQUEST, {
      schemaVersion: "1",
      status: "deferred",
      reason: "context only",
      funnel: NOT_RUN_FUNNEL,
      context: {
        schemaVersion: "1",
        purpose: "test-generation",
        entries,
        usedBytes: entries.reduce((total, entry) => total + entry.byteCount, 0),
        budgetBytes: 64,
        droppedForBudget: 0,
        omissions,
      },
    });

    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") {
      expect(outcome.context?.entries).toEqual(entries);
      expect(outcome.context?.omissions).toEqual(omissions);
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

  it("maps an assured candidate's funnel evidence (coverage delta + mutants killed)", () => {
    const wire: EditorTestGenerationWireResponse = {
      schemaVersion: "1",
      status: "generated",
      assurance: "assured",
      funnel: {
        ...NOT_RUN_FUNNEL,
        executionEnabled: true,
        candidatesGenerated: 1,
        candidatesSurfaced: 1,
        build: "passed",
        pass: "passed",
        stability: "passed",
        coverage: "passed",
        mutation: "passed",
        antiTautology: "passed",
        coverageLineDelta: 5,
        coverageBranchDelta: 2,
        mutantsKilled: 4,
        mutantsTotal: 6,
      },
      patch: {
        patchId: "p2",
        files: [
          {
            path: "src/a.test.ts",
            changeKind: "added",
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "it('x', () => {});\n",
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
      expect(outcome.assurance).toBe("assured");
      expect(outcome.funnel.coverageLineDelta).toBe(5);
      expect(outcome.funnel.mutantsKilled).toBe(4);
      expect(outcome.funnel.mutantsTotal).toBe(6);
      expect(outcome.reason).toBeUndefined();
    }
  });

  it("carries the rejection reason for an unverified (rejected) candidate", () => {
    const wire: EditorTestGenerationWireResponse = {
      schemaVersion: "1",
      status: "generated",
      assurance: "unverified",
      reason: "The generated candidate does not increase coverage.",
      funnel: {
        ...NOT_RUN_FUNNEL,
        executionEnabled: true,
        candidatesGenerated: 1,
        coverage: "failed",
      },
      patch: {
        patchId: "p3",
        files: [
          {
            path: "src/a.test.ts",
            changeKind: "added",
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "it('x', () => {});\n",
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
      expect(outcome.reason).toContain("coverage");
    }
  });
});
