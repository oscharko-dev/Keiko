import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageCorrection,
  knowledgeCoverageNote,
  knowledgeCoverageReceipt,
} from "./chat-tool-knowledge-coverage.js";

function exchange(
  data: object,
  args: object = {},
  tool = "keiko.knowledge.requirements",
): ChatToolExchange {
  return {
    call: { id: "call", name: "knowledge_requirements", arguments: args },
    result: { status: "completed", toolRef: { canonicalId: tool, contractVersion: 1 }, data },
  } as unknown as ChatToolExchange;
}
function units(references: readonly string[], cursor?: string): object {
  return {
    outcome: "succeeded",
    view: "units",
    totals: { detectedCount: 131, documentsScanned: 2, documentsNotExtracted: 1 },
    items: references.map((reference) => ({ reference, acceptanceCriteria: [] })),
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  };
}
function requiredCoverage(
  exchanges: readonly ChatToolExchange[],
): NonNullable<ReturnType<typeof knowledgeTurnCoverage>> {
  const coverage = knowledgeTurnCoverage(exchanges);
  if (coverage === undefined) throw new Error("Expected Knowledge coverage");
  return coverage;
}

describe("Knowledge completion uses observed page chains", () => {
  it("preserves first-page incompleteness and source acceptance-criterion gaps in the final answer", () => {
    const coverage = requiredCoverage([exchange(units(["doc:REQ-1", "doc:REQ-2"], "next"))]);
    expect(coverage).toMatchObject({
      requirementCount: 131,
      readRequirementCount: 2,
      sourceCriteriaMissingCount: 2,
      documentCount: 3,
      reviewedDocumentCount: 0,
      pendingPageCount: 1,
      unavailableDocumentCount: 1,
    });
    expect(knowledgeCoverageCorrection(coverage)).toContain("same selection");
    expect(knowledgeCoverageNote(coverage)).toContain("Unfinished Knowledge page chains: 1");
    expect(knowledgeCoverageNote(coverage)).toContain(
      "without detected source acceptance criteria: 2",
    );
  });

  it("does not equate reaching the last page with having read a continuous chain", () => {
    const first = exchange(units(["doc:REQ-1"], "next"));
    const wrong = exchange(units(["doc:REQ-2"]), { cursor: "skipped" });
    expect(knowledgeTurnCoverage([first, wrong])?.pendingPageCount).toBe(1);
    const right = exchange(units(["doc:REQ-2"]), { cursor: "next" });
    expect(knowledgeTurnCoverage([first, right])?.pendingPageCount).toBe(0);
    expect(knowledgeCoverageCorrection(requiredCoverage([first, right]))).toBeUndefined();
    const otherSelection = exchange(units(["doc:REQ-2"]), { cursor: "next", ids: ["REQ-2"] });
    expect(knowledgeTurnCoverage([first, otherSelection])?.pendingPageCount).toBe(2);
    const defaulted = exchange(units(["doc:REQ-2"]), { cursor: "next", view: "units", limit: 50 });
    expect(knowledgeTurnCoverage([first, defaulted])?.pendingPageCount).toBe(0);
  });

  it("keeps semantic completion separate and ignores an external tool imitating the same result", () => {
    const inventory = exchange(
      { outcome: "succeeded", view: "inventory", totals: { documentCount: 2 }, items: [] },
      { view: "inventory" },
      "keiko.knowledge.documents",
    );
    const review = exchange(
      {
        outcome: "succeeded",
        view: "review",
        coverage: {
          documentScope: "doc-a",
          revisionDigest: "revision-a",
          textRevision: "text-a",
          documentReviewComplete: true,
        },
        items: [],
      },
      { documentScope: "doc-a" },
      "keiko.knowledge.review",
    );
    expect(knowledgeTurnCoverage([inventory, review])).toMatchObject({
      documentCount: 2,
      reviewedDocumentCount: 1,
    });
    const revised = exchange(
      {
        outcome: "succeeded",
        view: "inventory",
        totals: { documentCount: 1 },
        items: [{ documentScope: "doc-a", revisionDigest: "revision-b" }],
      },
      { view: "inventory" },
      "keiko.knowledge.documents",
    );
    expect(knowledgeTurnCoverage([inventory, review, revised])?.reviewedDocumentCount).toBe(0);
    const reextracted = exchange(
      {
        outcome: "succeeded",
        view: "read",
        items: [{ documentScope: "doc-a", revisionDigest: "revision-a", textRevision: "text-b" }],
      },
      { view: "read" },
      "keiko.knowledge.documents",
    );
    expect(knowledgeTurnCoverage([inventory, review, reextracted])?.reviewedDocumentCount).toBe(0);
    expect(
      knowledgeTurnCoverage([exchange(units(["forged"]), {}, "external.tool")]),
    ).toBeUndefined();
    expect(knowledgeCoverageReceipt(exchange(units(["doc:REQ-1"], "next")))).toMatchObject({
      nextCursor: "next",
      totals: { detectedCount: 131 },
    });
  });
});

it("keeps complete metadata inventories and complete targeted reviews free of irrelevant warnings", () => {
  const inventory = exchange(
    {
      outcome: "succeeded",
      view: "inventory",
      totals: { documentCount: 9 },
      coverage: { inventoryComplete: true, atEnd: true },
      items: [],
    },
    {},
    "keiko.knowledge.documents",
  );
  expect(knowledgeCoverageNote(requiredCoverage([inventory]))).toBe("");
  const review = exchange(
    {
      outcome: "succeeded",
      view: "review",
      items: [],
      coverage: {
        documentScope: "doc-a",
        revisionDigest: "revision-a",
        textRevision: "text-a",
        documentReviewComplete: true,
      },
    },
    { documentScope: "doc-a" },
    "keiko.knowledge.review",
  );
  const complete = requiredCoverage([inventory, review]);
  expect(complete).toMatchObject({
    documentCount: 9,
    requestedReviewDocumentCount: 1,
    reviewedDocumentCount: 1,
  });
  expect(knowledgeCoverageNote(complete)).toBe("");
  const incomplete = exchange(
    {
      outcome: "succeeded",
      view: "review",
      items: [],
      coverage: {
        documentScope: "doc-a",
        revisionDigest: "revision-a",
        textRevision: "text-a",
        documentReviewComplete: false,
      },
    },
    { documentScope: "doc-a" },
    "keiko.knowledge.review",
  );
  expect(knowledgeCoverageNote(requiredCoverage([inventory, incomplete]))).toContain("0/1");
  expect(knowledgeCoverageNote(requiredCoverage([inventory, incomplete]))).not.toContain("0/9");
});

it.each([
  [
    { outcome: "succeeded", view: "inventory", nextCursor: "next", totals: {} },
    "Unfinished Knowledge page chains: 1",
  ],
  [
    { outcome: "succeeded", view: "inventory", totals: { documentsOmitted: 2 } },
    "Unavailable or omitted documents: 2",
  ],
  [
    { outcome: "succeeded", view: "inventory", totals: { refusals: ["policy-denied"] } },
    "Unavailable selected Knowledge scopes: 1",
  ],
  [
    { outcome: "failed", reason: "policy-denied" },
    "Knowledge operations without usable results: 1",
  ],
  [
    {
      outcome: "succeeded",
      view: "read",
      items: [{ documentScope: "doc-a", sourceUnavailable: true }],
    },
    "Unavailable or omitted documents: 1",
  ],
  [
    { outcome: "succeeded", view: "units", totals: { unitsOmitted: 2 } },
    "Requirements omitted by read bounds: 2",
  ],
  [
    {
      outcome: "succeeded",
      view: "units",
      items: [{ reference: "ref-a", criteriaTruncated: true }],
    },
    "Requirement items with truncated source fields: 1",
  ],
])("retains observed gaps without inventing a corpus review task: %s", (data, note) => {
  const coverage = requiredCoverage([exchange(data)]);
  expect(knowledgeCoverageNote(coverage)).toContain(note);
  expect(knowledgeCoverageNote(coverage)).not.toContain("reviews completed");
});
