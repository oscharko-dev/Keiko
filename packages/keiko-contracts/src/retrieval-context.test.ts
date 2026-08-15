import { describe, expect, it } from "vitest";
import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SCHEMA_VERSION,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  embeddingProvidersAllowed,
  isCodingContextPurpose,
  toCodingContextWirePack,
  type CodingContextPack,
  type CodingContextPurpose,
  type CodingContextSourceKind,
} from "./coding-context.js";
import {
  RETRIEVAL_CONTEXT_BUDGETS,
  RETRIEVAL_CONTEXT_PURPOSES,
  RETRIEVAL_CONTEXT_SCHEMA_VERSION,
  RETRIEVAL_CONTEXT_SOURCE_KINDS,
  RETRIEVAL_CONTEXT_SOURCE_TIERS,
  isRetrievalContextCitation,
  isRetrievalContextPurpose,
  tierForRetrievalContextSource,
  toRetrievalContextWirePack,
  type RetrievalContextPack,
  type RetrievalContextRequest,
} from "./retrieval-context.js";

type CodingRetrievalPack = RetrievalContextPack<CodingContextSourceKind, CodingContextPurpose>;

function asNeutral(pack: CodingContextPack): CodingRetrievalPack {
  return pack;
}

function asCoding(pack: CodingRetrievalPack): CodingContextPack {
  return pack;
}

function codingPack(): CodingContextPack {
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "completion",
    excerpts: [
      {
        citation: {
          sourceKind: "repo-search",
          sourceTier: "first-party-workspace",
          id: "fixture-1",
          score: 0.75,
          rank: 0,
          citationRef: "fixture.ts",
          byteCount: 7,
          truncated: false,
        },
        text: "private",
      },
    ],
    usedBytes: 7,
    budgetBytes: 32_768,
    droppedForBudget: 0,
    omissions: [{ sourceKind: "memory", reason: "unavailable" }],
  };
}

describe("retrieval-context coding profile", () => {
  it("keeps the coding aliases assignable both ways and wire bytes unchanged", () => {
    const pack = asCoding(asNeutral(codingPack()));
    const wire = toCodingContextWirePack(pack);

    expect(JSON.stringify(wire)).toBe(
      '{"schemaVersion":"1","purpose":"completion","entries":[{"sourceKind":"repo-search","sourceTier":"first-party-workspace","id":"fixture-1","score":0.75,"rank":0,"citationRef":"fixture.ts","byteCount":7,"truncated":false}],"usedBytes":7,"budgetBytes":32768,"droppedForBudget":0,"omissions":[{"sourceKind":"memory","reason":"unavailable"}]}',
    );
    expect(toRetrievalContextWirePack(pack)).toEqual(wire);
    expect(RETRIEVAL_CONTEXT_SCHEMA_VERSION).toBe(CODING_CONTEXT_SCHEMA_VERSION);
  });

  it("spreads every coding budget unchanged into the total neutral budget map", () => {
    for (const purpose of CODING_CONTEXT_PURPOSES) {
      expect(RETRIEVAL_CONTEXT_BUDGETS[purpose]).toBe(CODING_CONTEXT_BUDGETS[purpose]);
    }
    for (const purpose of RETRIEVAL_CONTEXT_PURPOSES) {
      expect(RETRIEVAL_CONTEXT_BUDGETS[purpose].budgetBytes).toBeGreaterThan(0);
      expect(embeddingProvidersAllowed(purpose)).toBe(
        RETRIEVAL_CONTEXT_BUDGETS[purpose].allowEmbeddingProviders,
      );
    }
    expect(embeddingProvidersAllowed("inline")).toBe(false);
    expect(embeddingProvidersAllowed("diagnostic")).toBe(false);
  });

  it("keeps neutral purposes and kinds outside the closed coding vocabulary", () => {
    expect(isRetrievalContextPurpose("chat-grounding")).toBe(true);
    expect(isCodingContextPurpose("chat-grounding")).toBe(false);
    expect(RETRIEVAL_CONTEXT_SOURCE_KINDS).toContain("graph-relations");
    expect(RETRIEVAL_CONTEXT_SOURCE_KINDS).toContain("entailment-evidence");
    expect(CODING_CONTEXT_SOURCE_KINDS).not.toContain("graph-relations");
    expect(CODING_CONTEXT_SOURCE_KINDS).not.toContain("entailment-evidence");
  });

  it("supports a neutral request without editor focus coordinates", () => {
    const request: RetrievalContextRequest = {
      schemaVersion: RETRIEVAL_CONTEXT_SCHEMA_VERSION,
      purpose: "chat-grounding",
    };
    expect(request).toEqual({ schemaVersion: "1", purpose: "chat-grounding" });
  });
});

describe("isRetrievalContextCitation", () => {
  const citation = {
    sourceKind: "graph-relations",
    sourceTier: "indexed-knowledge",
    id: "relation-1",
    score: 1,
    rank: 0,
    citationRef: undefined,
    byteCount: 3,
    truncated: false,
  } as const;

  it("accepts neutral citations and rejects every content-bearing key", () => {
    expect(isRetrievalContextCitation(citation)).toBe(true);
    expect(isRetrievalContextCitation({ ...citation, text: "secret" })).toBe(false);
    expect(isRetrievalContextCitation({ ...citation, excerpt: "secret" })).toBe(false);
    expect(isRetrievalContextCitation({ ...citation, content: "secret" })).toBe(false);
  });

  // KEIKO-0176: externally-authored connected content must not share the tier that means "the
  // user's own workspace files", or an evidence manifest's tierCounts cannot separate the two.
  it("gives externally-authored connected context its own trust tier", () => {
    expect(tierForRetrievalContextSource("connected-context")).toBe("external-connected");
    for (const kind of ["repo-search", "files-focus", "editor-state", "git-context"] as const) {
      expect(tierForRetrievalContextSource(kind)).toBe("first-party-workspace");
    }
    expect(RETRIEVAL_CONTEXT_SOURCE_TIERS).toContain("external-connected");
  });

  // ADR-0152 D6 follow-on: this neutral tier and the CODING tier for the same source kind now
  // DELIBERATELY diverge (see the comment on CODING_CONTEXT_SOURCE_TIER_BY_KIND) — the neutral
  // improvement must never be re-aliased back onto the existing coding wire without its own
  // lockstep schema decision. Pinned here so the two tables' intentional disagreement on
  // "connected-context" reads as a decision, not as coverage that just hasn't caught up yet.
  it("keeps the neutral and coding tiers for connected-context deliberately different (ADR-0152 D6)", () => {
    expect(tierForRetrievalContextSource("connected-context")).toBe("external-connected");
    expect(CODING_CONTEXT_SOURCE_TIER_BY_KIND["connected-context"]).toBe("first-party-workspace");
  });

  // KEIKO-0400: sourceKind and sourceTier were two independent membership checks, so a citation
  // could declare a tier that is not the one this package assigns to its own kind — letting it
  // misrepresent its trust tier to any consumer that reads sourceTier rather than re-deriving it.
  it("rejects a citation whose sourceTier is not the canonical tier for its sourceKind", () => {
    for (const sourceKind of RETRIEVAL_CONTEXT_SOURCE_KINDS) {
      const canonical = tierForRetrievalContextSource(sourceKind);
      const wrong = RETRIEVAL_CONTEXT_SOURCE_TIERS.find((tier) => tier !== canonical);
      expect(wrong).toBeDefined();
      expect(isRetrievalContextCitation({ ...citation, sourceKind, sourceTier: canonical })).toBe(
        true,
      );
      expect(isRetrievalContextCitation({ ...citation, sourceKind, sourceTier: wrong })).toBe(
        false,
      );
    }
  });
});
