import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { knowledgeToolOutcomeView, jiraToolOutcomeView } from "./jira-tool-outcome";
import { jiraToolPartialNotice } from "./jira-tool-presentation";

function exchange(name: string, data: CatalogJsonObject, version = name === "review" ? 2 : 1): ChatToolExchange {
  return { call: { id: "knowledge-receipt", name: `knowledge_${name}`, arguments: {} }, result: {
    schemaVersion: 1, invocationId: "knowledge-result", toolRef: createToolRef(`keiko.knowledge.${name}`, version),
    projectionDigest: null, effectStarted: false, metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
    status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null }, data,
  } };
}
const UNIT = { reference: "scope-a:REQ-1", title: "Retain source context", statement: "The system shall retain evidence.",
  documentScope: "scope-a", documentName: "Requirements.pdf", pageLabel: "7", sectionPath: ["System", "Evidence"],
  characterStart: 0, characterEnd: 48, acceptanceCriteria: [{ id: "AC-1", text: "Evidence survives reload." }] };
const DOCUMENT = { documentScope: "scope-a", documentName: "Requirements.pdf", extractionStatus: "extracted" };
const PROPOSAL_SOURCE = {
  documentScope: "scope-a", characterStart: 0, characterEnd: 48,
  quote: "retain evidence", quoteTruncated: false,
};
const PROPOSAL = { proposalId: "finding-a", origin: "model-proposal", status: "proposed", kind: "clarification",
  proposal: "Clarify retention duration.", question: "How long must evidence be retained?",
  sources: [PROPOSAL_SOURCE] };
const UNSUPPORTED_RESULTS: readonly CatalogJsonObject[] = [
  { outcome: "succeeded", view: "future", items: [UNIT] },
  { outcome: "succeeded", view: "units", items: [{ arbitrary: "opaque" }] },
  { outcome: "failed", view: "units", items: [UNIT] },
  { outcome: "succeeded", view: "units", items: { reference: "wrong-shape" } },
];

describe("versioned Knowledge receipts in the existing result owner", () => {
  it("retains requirement identity, source page, section and criteria without creating links", () => {
    const input = exchange("requirements", { outcome: "succeeded", view: "units", totals: { detectedCount: 8, matchedCount: 2, unitsOmitted: 0 },
      items: [UNIT], nextCursor: "private-cursor" });
    const view = jiraToolOutcomeView(input);
    expect(view).toMatchObject({ returnedCount: 1, total: 2, unreadableCount: 0, failure: undefined,
      items: [{ key: UNIT.reference, name: UNIT.title, body: UNIT.statement, facts: expect.arrayContaining([
        { label: "chat.knowledge.outcome.page", value: "7" },
        { label: "chat.knowledge.outcome.section", value: "System › Evidence" },
        { label: "chat.knowledge.outcome.criteria", value: "AC-1: Evidence survives reload." },
      ]) }] });
    expect(jiraToolPartialNotice(input)).toBe("chat.requirements.partial");
    expect(view.items[0]).not.toHaveProperty("href");
    expect(JSON.stringify(view)).not.toContain("private-cursor");
  });
  it.each(["inventory", "search", "read"])("shows documents %s without using document counts as search-result totals", (view) => {
    const input = exchange("documents", { outcome: "succeeded", view, totals: { documentCount: 9 },
      items: [{ ...DOCUMENT, text: "Source text <script> is plain text.", characterStart: 0, characterEnd: 40, positionSpace: "redacted-document-text" }],
      coverage: { documentComplete: false } });
    expect(knowledgeToolOutcomeView(input)).toMatchObject({ returnedCount: 1, total: view === "inventory" ? 9 : undefined,
      items: [{ name: DOCUMENT.documentName, body: "Source text <script> is plain text.", labels: ["chat.knowledge.outcome.redactedPositions"] }] });
    expect(jiraToolPartialNotice(input)).toBe("chat.knowledge.partial");
  });
  it("keeps explicit empty text and unavailable source distinct", () => {
    const data = { outcome: "succeeded", view: "read", items: [{ ...DOCUMENT, text: "" }] };
    expect(knowledgeToolOutcomeView(exchange("documents", data))?.items[0]?.labels).toContain("chat.knowledge.outcome.emptyText");
    const unavailable = exchange("documents", { ...data, items: [{ ...DOCUMENT, text: "must not render", sourceUnavailable: true }] });
    expect(knowledgeToolOutcomeView(unavailable)?.items[0]).toMatchObject({ labels: ["chat.knowledge.outcome.sourceUnavailable"] });
    expect(knowledgeToolOutcomeView(unavailable)?.items[0]?.body).toBeUndefined();
  });
  it("shows the requirements document inventory and query references without running or linking queries", () => {
    const documents = exchange("requirements", {
      outcome: "succeeded", view: "documents", items: [{ ...DOCUMENT, unitCount: 4 }],
    });
    expect(knowledgeToolOutcomeView(documents)).toMatchObject({
      total: undefined,
      items: [{ name: DOCUMENT.documentName, facts: expect.arrayContaining([
        { label: "chat.knowledge.outcome.detected", value: "4" },
      ]) }],
    });
    const query = exchange("requirements", {
      outcome: "succeeded", view: "change-queries", items: [{
        purpose: "traced", jql: 'project = SYN AND labels = "REQ-1"', requirementIds: ["REQ-1"],
      }],
    });
    expect(knowledgeToolOutcomeView(query)?.items).toEqual([{
      facts: [
        { label: "chat.knowledge.outcome.requirements", value: "REQ-1" },
        { label: "chat.knowledge.outcome.query", value: 'project = SYN AND labels = "REQ-1"' },
      ],
      labels: [],
    }]);
  });
  it("retains change counts and references while a partial baseline stays visibly partial", () => {
    const input = exchange("requirements", {
      outcome: "succeeded", view: "changes", changes: {
        baseline: { complete: false }, counts: { changed: 1, removed: 0, untraced: 1, unchanged: 0 },
        changed: [{ id: "REQ-1", title: "Changed source", issueCount: 2, issues: ["SYN-1", "SYN-2"] }],
        removed: [], untraced: ["REQ-2"], unchanged: [], truncated: [],
      },
    });
    expect(knowledgeToolOutcomeView(input)).toMatchObject({
      returnedCount: undefined, total: undefined,
      facts: expect.arrayContaining([{ label: "chat.knowledge.outcome.removedCount", value: "0" }]),
      items: [
        { key: "REQ-1", name: "Changed source", labels: ["chat.knowledge.outcome.changed"],
          facts: [{ label: "chat.knowledge.outcome.linkedIssues", value: "2" }] },
        { key: "REQ-2", labels: ["chat.knowledge.outcome.untraced"] },
      ],
    });
    expect(jiraToolPartialNotice(input)).toBe("chat.requirements.partial");
    expect(knowledgeToolOutcomeView(exchange("requirements", {
      outcome: "succeeded", view: "changes", changes: { counts: { unknown: 1 } },
    }))).toBeUndefined();
  });
  it("labels cited semantic findings as proposals without claiming exhaustive review", () => {
    const input = exchange("review", { outcome: "succeeded", view: "review", items: [PROPOSAL],
      coverage: { documentReviewComplete: false, windowReviewComplete: false } });
    const view = knowledgeToolOutcomeView(input);
    expect(view).toMatchObject({ returnedCount: 1, total: undefined, labels: ["chat.knowledge.outcome.reviewScope"],
      items: [{ key: "finding-a", body: PROPOSAL.proposal, labels: ["chat.knowledge.outcome.proposal", "chat.knowledge.outcome.clarification"],
        facts: [{ label: "chat.knowledge.outcome.sources", value: "scope-a · 0–48\nretain evidence" },
          { label: "chat.knowledge.outcome.question", value: PROPOSAL.question }] }] });
    expect(jiraToolPartialNotice(input)).toBe("chat.knowledge.partial");
  });
  it("retains shortened quotation evidence and refuses unknown proposal kinds", () => {
    const item = { ...PROPOSAL, sources: [{ ...PROPOSAL_SOURCE, quoteTruncated: true }] };
    const receipt = exchange("review", { outcome: "succeeded", view: "review", items: [item] });
    expect(knowledgeToolOutcomeView(receipt)?.items[0]?.labels).toContain("chat.knowledge.outcome.quoteTruncated");
    expect(knowledgeToolOutcomeView(exchange("review", {
      outcome: "succeeded", view: "review", items: [{ ...PROPOSAL, kind: "toString" }],
    }))).toBeUndefined();
  });
  it("preserves known zero and does not invent absent totals", () => {
    expect(knowledgeToolOutcomeView(exchange("requirements", { outcome: "succeeded", view: "units", totals: { matchedCount: 0 }, items: [] })))
      .toMatchObject({ returnedCount: 0, total: 0 });
    expect(knowledgeToolOutcomeView(exchange("requirements", { outcome: "succeeded", view: "units", items: [] })))
      .toMatchObject({ returnedCount: 0, total: undefined });
  });
  it("retains the selected source window when a review returns no proposals", () => {
    const input = exchange("review", {
      outcome: "succeeded", view: "review", items: [],
      coverage: { documentScope: "scope-a", characterStart: 0, characterEnd: 48 },
    });
    expect(knowledgeToolOutcomeView(input)).toMatchObject({
      returnedCount: 0, total: undefined,
      facts: [
        { label: "chat.knowledge.outcome.documentReference", value: "scope-a" },
        { label: "chat.knowledge.outcome.characters", value: "0–48" },
      ],
    });
  });
  it.each(UNSUPPORTED_RESULTS)("keeps unsupported Knowledge payloads in the existing fallback: %#", (data) => {
    expect(knowledgeToolOutcomeView(exchange("requirements", data))).toBeUndefined();
  });
  it("does not treat a familiar alias, wrong canonical ID or old review version as a current source receipt", () => {
    const input = exchange("requirements", { outcome: "succeeded", view: "units", items: [UNIT] });
    if (input.result === undefined) throw new TypeError("Missing result fixture");
    for (const toolRef of [null, createToolRef("keiko.external.tool", 1)])
      expect(knowledgeToolOutcomeView({ ...input, result: { ...input.result, toolRef } })).toBeUndefined();
    expect(knowledgeToolOutcomeView(exchange("review", { outcome: "succeeded", view: "review", items: [PROPOSAL] }, 1))).toBeUndefined();
  });
});
