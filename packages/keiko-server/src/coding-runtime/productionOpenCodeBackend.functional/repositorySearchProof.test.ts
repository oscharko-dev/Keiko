import { describe, expect, it } from "vitest";
import { scriptedResponse, type ScriptState } from "./_support.js";
import {
  H1_PROOF_SEARCH_CALL_ID,
  repositorySearchReadHandoff,
  type RepositorySearchConsumptionProof,
} from "./repositorySearchProof.js";

function transcript(search: unknown): string {
  return JSON.stringify([
    {
      role: "tool",
      toolCallId: H1_PROOF_SEARCH_CALL_ID,
      content: JSON.stringify({ status: "completed", search }),
    },
  ]);
}

const SEARCH = {
  ok: true,
  kind: "search",
  hits: [
    {
      path: "src/actual-result.ts",
      startLine: 7,
      endLine: 9,
      snippet: "the useful marker",
    },
  ],
};

describe("real-binary H1 model response boundary", () => {
  it("requests repository contents before choosing a file to read", () => {
    const script = {
      mode: "productive-search",
      calls: 0,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    scriptedResponse(script);
    expect(scriptedResponse(script).toolCalls[0]).toMatchObject({
      name: "keiko_repository_search",
      arguments: { mode: "literal", query: script.old.trim() },
    });
  });

  it("derives the next bounded read from the correlated result rather than a fixture path", () => {
    const evidence: RepositorySearchConsumptionProof[] = [];
    expect(
      repositorySearchReadHandoff(transcript(SEARCH), "useful marker", (proof) => {
        evidence.push(proof);
      }),
    ).toEqual({ relativePath: "src/actual-result.ts", startLine: 7, maxLines: 3 });
    expect(evidence).toEqual([
      expect.objectContaining({
        hitCount: 1,
        startLine: 7,
        endLine: 9,
        readTargetDerivedFromResult: true,
      }),
    ]);
    expect(evidence.at(0)?.pathDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("actual-result");
    expect(JSON.stringify(evidence)).not.toContain("useful marker");
  });

  it.each([
    { ok: false, reason: "denied" },
    { ...SEARCH, hits: [] },
    { ...SEARCH, hits: [{ ...SEARCH.hits[0], startLine: 0 }] },
    { ...SEARCH, hits: [{ ...SEARCH.hits[0], endLine: 2 }] },
    { ...SEARCH, hits: [{ ...SEARCH.hits[0], snippet: "unrelated result" }] },
  ])("refuses unusable search results instead of returning a canned read", (search) => {
    expect(() =>
      repositorySearchReadHandoff(transcript(search), "useful marker", undefined),
    ).toThrow(TypeError);
  });

  it("rejects result text without its original tool-call identity", () => {
    const wrong = transcript(SEARCH).replace(H1_PROOF_SEARCH_CALL_ID, "unrelated-call");
    expect(() => repositorySearchReadHandoff(wrong, "useful marker", undefined)).toThrow(TypeError);
  });
});
