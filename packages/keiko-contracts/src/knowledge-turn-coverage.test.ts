import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_TOOL_IDENTITIES,
  isCanonicalKnowledgeReviewRef,
  isCanonicalKnowledgeToolRef,
} from "./knowledge-turn-coverage.js";

describe("canonical Knowledge tool identities", () => {
  it("accepts exactly the table entries", () => {
    for (const t of KNOWLEDGE_TOOL_IDENTITIES) {
      expect(isCanonicalKnowledgeToolRef(t.name, t)).toBe(true);
    }
  });

  it("rejects a wrong version, a wrong id, a crossed name and absent refs", () => {
    for (const t of KNOWLEDGE_TOOL_IDENTITIES) {
      expect(
        isCanonicalKnowledgeToolRef(t.name, { ...t, contractVersion: t.contractVersion + 1 }),
      ).toBe(false);
      expect(isCanonicalKnowledgeToolRef(t.name, { ...t, canonicalId: "keiko.other" })).toBe(false);
      const other = KNOWLEDGE_TOOL_IDENTITIES.find((o) => o.name !== t.name);
      if (other !== undefined) expect(isCanonicalKnowledgeToolRef(t.name, other)).toBe(false);
    }
    expect(isCanonicalKnowledgeToolRef("knowledge_review", undefined)).toBe(false);
    expect(isCanonicalKnowledgeToolRef("knowledge_review", null)).toBe(false);
    expect(isCanonicalKnowledgeToolRef("unknown", KNOWLEDGE_TOOL_IDENTITIES[0])).toBe(false);
  });

  it("recognises only the review entry as the review ref", () => {
    for (const t of KNOWLEDGE_TOOL_IDENTITIES) {
      expect(isCanonicalKnowledgeReviewRef(t)).toBe(t.name === "knowledge_review");
    }
    const review = KNOWLEDGE_TOOL_IDENTITIES.find((t) => t.name === "knowledge_review");
    expect(review).toBeDefined();
    if (review === undefined) return;
    expect(
      isCanonicalKnowledgeReviewRef({ ...review, contractVersion: review.contractVersion + 1 }),
    ).toBe(false);
  });
});
