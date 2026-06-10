// Unit tests for the GroundedAnswerContextPackSummary builder (Issue #187 / ADR-0022).
// Each test mutates one field of a known-good fixture so failures point precisely at the
// broken invariant; tests assert structural absence of leak vectors (scopeId, workspaceRoot,
// query text, excerpt content) and the documented `-1` sentinel for workspace-root scope.

import { describe, expect, it } from "vitest";
import {
  buildGroundedAnswerContextPackSummary,
  DEFAULT_GROUNDING_LIMITS,
  GROUNDING_LIMIT_CEILINGS,
  MAX_CONNECTED_SOURCES,
  MAX_LOCAL_KNOWLEDGE_SOURCES,
  resolveGroundingLimits,
  type Chat,
  type ChatLocalKnowledgeScope,
  type GroundedAnswer,
  type GroundedAnswerContextPackSummary,
  type GroundingLimits,
  type HybridGroundedAnswer,
  type LocalKnowledgeEvidenceCitation,
} from "./bff-wire.js";
import {
  CANDIDATE_OMISSION_REASONS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type ExplorationUsage,
  type RetrievalQuery,
  type SelectedScope,
  type SelectedScopeKind,
} from "./connected-context.js";

const USAGE_FIXTURE: ExplorationUsage = {
  searchCalls: 3,
  filesRead: 5,
  excerptBytes: 12_400,
  modelInputTokens: 1_500,
  modelOutputTokens: 400,
  elapsedMs: 1_800,
  rerankCalls: 0,
};

function emptyOmittedCounts(): Record<CandidateOmissionReason, number> {
  const counts = {} as Record<CandidateOmissionReason, number>;
  for (const reason of CANDIDATE_OMISSION_REASONS) {
    counts[reason] = 0;
  }
  return counts;
}

function scope(kind: SelectedScopeKind, relativePaths: readonly string[]): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "cs-deadbeefcafef00d",
    workspaceRoot: "/home/dev/keiko",
    kind,
    relativePaths,
    conversationId: "chat-1",
    connectedAtMs: 1_700_000_000_000,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "how does foo work?",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 1_700_000_000_000,
  };
}

function pack(overrides: Partial<ConnectedContextPack> = {}): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: scope("files", ["src/foo.ts", "src/bar.ts"]),
    query: query(),
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: USAGE_FIXTURE,
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1_700_000_000_001,
    ledgerRef: undefined,
    ...overrides,
  };
}

describe("buildGroundedAnswerContextPackSummary", () => {
  it("produces a complete summary from a 2-file files-scope pack", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 4, 1_812);
    expect(summary.scopeId).toMatch(/^scope-[0-9a-f]{8}$/);
    const expected: GroundedAnswerContextPackSummary = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: summary.scopeId,
      scopeKind: "files",
      fileCount: 2,
      queryKind: "natural-language",
      usage: USAGE_FIXTURE,
      budget: DEFAULT_EXPLORATION_BUDGET,
      citationCount: 4,
      omittedCount: 0,
      omittedCounts: emptyOmittedCounts(),
      uncertaintyCount: 0,
      elapsedMs: 1_812,
    };
    expect(summary).toStrictEqual(expected);
  });

  it("maps workspace-root scope to the -1 file-count sentinel", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("workspace-root", []) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(-1);
    expect(summary.scopeKind).toBe("workspace-root");
  });

  it("maps directory scope to relativePaths.length (exactly 1)", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("directory", ["src/lib"]) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(1);
    expect(summary.scopeKind).toBe("directory");
  });

  it("maps files scope to relativePaths.length (>= 1)", () => {
    const summary = buildGroundedAnswerContextPackSummary(
      pack({ scope: scope("files", ["a.ts", "b.ts", "c.ts"]) }),
      0,
      0,
    );
    expect(summary.fileCount).toBe(3);
  });

  it("surfaces omitted and uncertainty counts from the pack arrays", () => {
    const p = pack({
      omitted: [
        { scopePath: "src/skip.ts", reason: "binary", omittedAtMs: 1 },
        { scopePath: "src/big.ts", reason: "size-exceeded", omittedAtMs: 2 },
      ],
      uncertainty: [{ kind: "no-evidence", claim: "no hits", impactedAtomIds: [], emittedAtMs: 3 }],
    });
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.omittedCount).toBe(2);
    expect(summary.omittedCounts.binary).toBe(1);
    expect(summary.omittedCounts["size-exceeded"]).toBe(1);
    expect(summary.omittedCounts.generated).toBe(0);
    expect(summary.uncertaintyCount).toBe(1);
  });

  it("initialises every omitted reason count to zero", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 0, 0);
    for (const reason of CANDIDATE_OMISSION_REASONS) {
      expect(summary.omittedCounts[reason]).toBe(0);
    }
  });

  it("surfaces usage and budget identity-equal to the source pack fields", () => {
    const p = pack();
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.usage).toBe(p.usage);
    expect(summary.budget).toBe(p.budget);
  });

  it("carries elapsedMs and citationCount verbatim from the caller's arguments", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 7, 9_999);
    expect(summary.citationCount).toBe(7);
    expect(summary.elapsedMs).toBe(9_999);
  });

  it("never carries scope.scopeId, workspaceRoot, relativePaths, or query.text on the summary", () => {
    const dangerous = pack({
      scope: {
        ...scope("files", ["src/.env", "src/keys.ts"]),
        scopeId: ["sk", "-scopeidsecret1234567890abcdef"].join(""),
        workspaceRoot: ["/leak/", "sk", "-AAAAAAAAAAAAAAAAAAAA"].join(""),
      },
      query: { ...query(), text: ["ghp", "_thisShouldNotEscape123456789abc"].join("") },
    });
    const summary = buildGroundedAnswerContextPackSummary(dangerous, 0, 0);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("workspaceRoot");
    expect(serialised).not.toContain("relativePaths");
    expect(serialised).not.toContain("scopeidsecret");
    expect(serialised).not.toContain("src/.env");
    expect(serialised).not.toContain("ghp_");
    expect(serialised).not.toContain("/leak/");
  });

  it("schemaVersion equals CONNECTED_CONTEXT_SCHEMA_VERSION (pin)", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 0, 0);
    expect(summary.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
  });

  it("budget with Infinity caps round-trips unchanged (UI renders '—' downstream)", () => {
    const p = pack({
      budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax: Number.POSITIVE_INFINITY },
    });
    const summary = buildGroundedAnswerContextPackSummary(p, 0, 0);
    expect(summary.budget.searchCallsMax).toBe(Number.POSITIVE_INFINITY);
  });

  it("structural test: summary JSON is bounded (well below the 1KB review target)", () => {
    const summary = buildGroundedAnswerContextPackSummary(pack(), 4, 1_812);
    expect(JSON.stringify(summary).length).toBeLessThan(1_000);
  });
});

// Epic #189 — the plural local-knowledge source list mirrors the #532 connected-source list.
describe("local-knowledge multi-source contract (#189)", () => {
  it("bounds the connector source list at the same cap as the connected source list", () => {
    expect(MAX_LOCAL_KNOWLEDGE_SOURCES).toBe(16);
    expect(MAX_LOCAL_KNOWLEDGE_SOURCES).toBe(MAX_CONNECTED_SOURCES);
  });

  it("derives the effective connector list via the documented reader rule (plural supersedes)", () => {
    const readerRule = (chat: Chat): readonly Chat["localKnowledgeScope"][] =>
      chat.localKnowledgeScopes ?? (chat.localKnowledgeScope ? [chat.localKnowledgeScope] : []);
    const base = {
      id: "c1",
      projectPath: "/p",
      title: "t",
      selectedModel: "m",
      branchLabel: undefined,
      status: undefined,
      connectedScope: undefined,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const single = {
      kind: "capsule",
      capsuleId: "cap-a",
      connectedAtMs: 1,
    } as ChatLocalKnowledgeScope;
    const list: readonly ChatLocalKnowledgeScope[] = [
      single,
      { kind: "capsule-set", capsuleSetId: "set-b", connectedAtMs: 2 } as ChatLocalKnowledgeScope,
    ];
    // Plural present → it wins.
    expect(
      readerRule({ ...base, localKnowledgeScopes: list, localKnowledgeScope: single }),
    ).toEqual(list);
    // Plural absent, singular present → 1-element list.
    expect(readerRule({ ...base, localKnowledgeScope: single })).toEqual([single]);
    // Neither → empty list.
    expect(readerRule({ ...base, localKnowledgeScope: undefined })).toEqual([]);
  });

  it("admits a source-tagged connector citation and the hybrid grounded answer member", () => {
    const citation: LocalKnowledgeEvidenceCitation = {
      stableId: "s1",
      marker: "[1]",
      label: "doc.md",
      score: 0.9,
      source: "Capsule A",
    };
    const hybrid: HybridGroundedAnswer = {
      groundingKind: "hybrid",
      userMessageId: "u1",
      assistantMessageId: "a1",
      content: "answer",
      citations: [],
      knowledgeCitations: [citation],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 5,
      contextPack: {
        kind: "hybrid",
        folderSourceCount: 1,
        connectorSourceCount: 2,
        folder: buildGroundedAnswerContextPackSummary(pack(), 0, 0),
        knowledge: {
          kind: "local-knowledge",
          scopeKind: "capsule-set",
          scopeId: "scope-1",
          scopeLabel: "Set B",
          capsuleCount: 2,
          sourceCount: 2,
          citationCount: 1,
          referenceBudget: 8,
          referencesUsed: 1,
        },
      },
    };
    const answer: GroundedAnswer = hybrid;
    expect(answer.groundingKind).toBe("hybrid");
    expect(citation.source).toBe("Capsule A");
  });
});

// ─── GroundingLimits contract ────────────────────────────────────────────────────
describe("GroundingLimits defaults and back-compat constants", () => {
  it("DEFAULT_GROUNDING_LIMITS.maxConnectedSources is 16", () => {
    expect(DEFAULT_GROUNDING_LIMITS.maxConnectedSources).toBe(16);
  });

  it("DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources is 16", () => {
    expect(DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources).toBe(16);
  });

  it("DEFAULT_GROUNDING_LIMITS.maxPromptReferences is 8", () => {
    expect(DEFAULT_GROUNDING_LIMITS.maxPromptReferences).toBe(8);
  });

  it("DEFAULT_GROUNDING_LIMITS.maxExcerptChars is 900", () => {
    expect(DEFAULT_GROUNDING_LIMITS.maxExcerptChars).toBe(900);
  });

  it("DEFAULT_GROUNDING_LIMITS.referenceBudget is 10", () => {
    expect(DEFAULT_GROUNDING_LIMITS.referenceBudget).toBe(10);
  });

  it("DEFAULT_GROUNDING_LIMITS.hybridMaxCandidates is 24", () => {
    expect(DEFAULT_GROUNDING_LIMITS.hybridMaxCandidates).toBe(24);
  });

  it("DEFAULT_GROUNDING_LIMITS.hybridMaxExcerptBytes is 131072", () => {
    expect(DEFAULT_GROUNDING_LIMITS.hybridMaxExcerptBytes).toBe(131_072);
  });

  it("back-compat MAX_CONNECTED_SOURCES equals DEFAULT_GROUNDING_LIMITS.maxConnectedSources", () => {
    expect(MAX_CONNECTED_SOURCES).toBe(DEFAULT_GROUNDING_LIMITS.maxConnectedSources);
  });

  it("back-compat MAX_LOCAL_KNOWLEDGE_SOURCES equals DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources", () => {
    expect(MAX_LOCAL_KNOWLEDGE_SOURCES).toBe(DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources);
  });

  it("back-compat assertion: MAX_LOCAL_KNOWLEDGE_SOURCES === MAX_CONNECTED_SOURCES (existing test contract)", () => {
    expect(MAX_LOCAL_KNOWLEDGE_SOURCES).toBe(MAX_CONNECTED_SOURCES);
  });
});

describe("resolveGroundingLimits", () => {
  it("returns defaults when called with no argument", () => {
    expect(resolveGroundingLimits()).toStrictEqual(DEFAULT_GROUNDING_LIMITS);
  });

  it("returns defaults when called with an empty partial", () => {
    expect(resolveGroundingLimits({})).toStrictEqual(DEFAULT_GROUNDING_LIMITS);
  });

  it("fills each supplied positive-integer field from the partial", () => {
    const result = resolveGroundingLimits({ maxConnectedSources: 4, referenceBudget: 5 });
    expect(result.maxConnectedSources).toBe(4);
    expect(result.referenceBudget).toBe(5);
    // remaining fields fall back to defaults
    expect(result.maxLocalKnowledgeSources).toBe(DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources);
    expect(result.maxPromptReferences).toBe(DEFAULT_GROUNDING_LIMITS.maxPromptReferences);
  });

  it("clamps an over-ceiling value to the ceiling (does NOT reject)", () => {
    const result = resolveGroundingLimits({ maxConnectedSources: 9999 });
    expect(result.maxConnectedSources).toBe(GROUNDING_LIMIT_CEILINGS.maxConnectedSources);
  });

  it("falls back to the default for a non-positive value (0)", () => {
    const result = resolveGroundingLimits({ maxConnectedSources: 0 });
    expect(result.maxConnectedSources).toBe(DEFAULT_GROUNDING_LIMITS.maxConnectedSources);
  });

  it("falls back to the default for a non-integer value (1.5)", () => {
    const result = resolveGroundingLimits({ maxConnectedSources: 1.5 });
    expect(result.maxConnectedSources).toBe(DEFAULT_GROUNDING_LIMITS.maxConnectedSources);
  });

  it("falls back to the default for a negative value (-1)", () => {
    const result = resolveGroundingLimits({ maxConnectedSources: -1 });
    expect(result.maxConnectedSources).toBe(DEFAULT_GROUNDING_LIMITS.maxConnectedSources);
  });

  it("all fields equal the defaults when every partial field is exactly the default value", () => {
    const result = resolveGroundingLimits({ ...DEFAULT_GROUNDING_LIMITS });
    expect(result).toStrictEqual(DEFAULT_GROUNDING_LIMITS);
  });

  it("result satisfies the GroundingLimits shape (all fields present and positive)", () => {
    const result = resolveGroundingLimits();
    for (const key of Object.keys(DEFAULT_GROUNDING_LIMITS) as (keyof GroundingLimits)[]) {
      expect(typeof result[key]).toBe("number");
      expect(result[key]).toBeGreaterThan(0);
    }
  });
});
