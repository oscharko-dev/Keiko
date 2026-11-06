import { describe, expect, it } from "vitest";
import { knowledgeTurnCoverage as sharedKnowledgeTurnCoverage } from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageCorrection,
  knowledgeCoverageIssues,
  knowledgeCoverageReceipt,
} from "./chat-tool-knowledge-coverage.js";

function isResultDataObject(value: CatalogJsonValue): value is CatalogJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  it("uses the same receipt projection as browser consumers", () => {
    expect(knowledgeTurnCoverage).toBe(sharedKnowledgeTurnCoverage);
    expect(knowledgeCoverageIssues(undefined)).toEqual([]);
  });

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
    expect(knowledgeCoverageIssues(coverage)).toEqual([
      { kind: "pending-reads", count: 1 },
      { kind: "unavailable-documents", count: 1 },
      { kind: "missing-criteria", count: 2 },
    ]);
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
          reviewFingerprint: "review-a",
          characterStart: 0,
          characterEnd: 10,
          documentChars: 10,
          windowReviewComplete: true,
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
  expect(knowledgeCoverageIssues(requiredCoverage([inventory]))).toEqual([]);
  const review = exchange(
    {
      outcome: "succeeded",
      view: "review",
      items: [],
      coverage: {
        documentScope: "doc-a",
        revisionDigest: "revision-a",
        textRevision: "text-a",
        reviewFingerprint: "review-a",
        characterStart: 0,
        characterEnd: 10,
        documentChars: 10,
        windowReviewComplete: true,
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
  expect(knowledgeCoverageIssues(complete)).toEqual([]);
  const incomplete = exchange(
    {
      outcome: "succeeded",
      view: "review",
      items: [],
      coverage: {
        documentScope: "doc-a",
        revisionDigest: "revision-a",
        textRevision: "text-a",
        reviewFingerprint: "review-a",
        characterStart: 0,
        characterEnd: 10,
        documentChars: 10,
        windowReviewComplete: false,
        documentReviewComplete: false,
      },
    },
    { documentScope: "doc-a" },
    "keiko.knowledge.review",
  );
  expect(knowledgeCoverageIssues(requiredCoverage([inventory, incomplete]))).toEqual([
    { kind: "requested-reviews", completed: 0, requested: 1 },
  ]);
});

it.each([
  [
    { outcome: "succeeded", view: "inventory", nextCursor: "next", totals: {} },
    { kind: "pending-reads", count: 1 },
  ],
  [
    { outcome: "succeeded", view: "inventory", totals: { documentsOmitted: 2 } },
    { kind: "unavailable-documents", count: 2 },
  ],
  [
    { outcome: "succeeded", view: "inventory", totals: { refusals: ["policy-denied"] } },
    { kind: "refused-scopes", count: 1 },
  ],
  [
    { outcome: "failed", reason: "policy-denied" },
    { kind: "failed-operations", count: 1 },
  ],
  [
    {
      outcome: "succeeded",
      view: "read",
      items: [{ documentScope: "doc-a", sourceUnavailable: true }],
    },
    { kind: "unavailable-documents", count: 1 },
  ],
  [
    { outcome: "succeeded", view: "units", totals: { unitsOmitted: 2 } },
    { kind: "omitted-requirements", count: 2 },
  ],
  [
    {
      outcome: "succeeded",
      view: "units",
      items: [{ reference: "ref-a", criteriaTruncated: true }],
    },
    { kind: "truncated-requirements", count: 1 },
  ],
])("retains observed gaps without inventing a corpus review task: %s", (data, issue) => {
  const coverage = requiredCoverage([exchange(data)]);
  expect(knowledgeCoverageIssues(coverage)).toContainEqual(issue);
  expect(
    knowledgeCoverageIssues(coverage).some((entry) => entry.kind === "requested-reviews"),
  ).toBe(false);
});

function reviewWindow(
  start: number,
  end: number,
  fingerprint = "current-review",
  complete = true,
): ChatToolExchange {
  return exchange(
    {
      outcome: "succeeded",
      view: "review",
      coverage: {
        documentScope: "doc-current",
        revisionDigest: "revision-current",
        textRevision: "text-current",
        reviewFingerprint: fingerprint,
        characterStart: start,
        characterEnd: end,
        documentChars: 12000,
        windowReviewComplete: complete,
        // A stale/global claim never substitutes for this turn's settled windows.
        documentReviewComplete: true,
      },
      items: [],
      ...(end < 12000 ? { nextCursor: "current-next" } : {}),
    },
    { documentScope: "doc-current", ...(start === 0 ? {} : { cursor: "current-next" }) },
    "keiko.knowledge.review",
  );
}

it("derives review completion only from current-turn settled windows and their identity", () => {
  const first = reviewWindow(0, 6000);
  const last = reviewWindow(6000, 12000);
  expect(requiredCoverage([last]).reviewedDocumentCount).toBe(0);
  expect(requiredCoverage([first, last]).reviewedDocumentCount).toBe(1);
  expect(requiredCoverage([first, reviewWindow(7000, 12000)]).reviewedDocumentCount).toBe(0);
  expect(
    requiredCoverage([first, reviewWindow(6000, 12000, "new-generation")]).reviewedDocumentCount,
  ).toBe(0);
  expect(
    requiredCoverage([first, reviewWindow(6000, 12000, "current-review", false)])
      .reviewedDocumentCount,
  ).toBe(0);
  const completed = last.result;
  if (completed?.status !== "completed") throw new Error("Expected a completed review result.");
  const data = completed.data;
  if (!isResultDataObject(data)) throw new Error("Expected structured review data.");
  const failed: ChatToolExchange = {
    ...last,
    result: { ...completed, status: "failed", reason: "provider-reported-error", page: null, data },
  };
  expect(requiredCoverage([first, failed]).reviewedDocumentCount).toBe(0);
  expect(
    requiredCoverage([first, last, reviewWindow(0, 6000, "current-review", false)])
      .reviewedDocumentCount,
  ).toBe(0);
});
