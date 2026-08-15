import { describe, expect, it } from "vitest";
import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SCHEMA_VERSION,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  CODING_CONTEXT_SOURCE_TIERS,
  buildContextSelectors,
  collectContextErrors,
  collectEditorSessionIdError,
  embeddingProvidersAllowed,
  isBoundedEditorSessionId,
  isCodingContextCitation,
  isCodingContextPurpose,
  isCostClass,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isStringArray,
  tierForCodingContextSource,
  toCodingContextWirePack,
  validateCodingContextRequest,
  type CodingContextCitation,
  type CodingContextExcerpt,
  type CodingContextPack,
  type CodingContextRequest,
} from "./coding-context.js";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";

function citation(overrides: Partial<CodingContextCitation> = {}): CodingContextCitation {
  return {
    sourceKind: "repo-search",
    sourceTier: "first-party-workspace",
    id: "a-0001",
    score: 0.9,
    rank: 0,
    citationRef: "foo.ts",
    byteCount: 128,
    truncated: false,
    ...overrides,
  };
}

function excerpt(
  text: string,
  overrides: Partial<CodingContextCitation> = {},
): CodingContextExcerpt {
  return { citation: citation(overrides), text };
}

function validRequest(overrides: Partial<CodingContextRequest> = {}): CodingContextRequest {
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "completion",
    documentPath: "src/foo.ts",
    symbol: undefined,
    queryText: undefined,
    changedFiles: undefined,
    capsuleId: undefined,
    capsuleSetId: undefined,
    ...overrides,
  };
}

describe("coding-context purpose + tiering", () => {
  it("recognises exactly the declared purposes", () => {
    for (const purpose of CODING_CONTEXT_PURPOSES) {
      expect(isCodingContextPurpose(purpose)).toBe(true);
    }
    expect(isCodingContextPurpose("apply-patch")).toBe(false);
    expect(isCodingContextPurpose(42)).toBe(false);
  });

  it("maps every source kind to a declared trust tier (no untiered source)", () => {
    for (const kind of CODING_CONTEXT_SOURCE_KINDS) {
      const tier = tierForCodingContextSource(kind);
      expect(CODING_CONTEXT_SOURCE_TIERS).toContain(tier);
      expect(CODING_CONTEXT_SOURCE_TIER_BY_KIND[kind]).toBe(tier);
    }
  });

  it("tiers workspace, knowledge, and memory sources distinctly (LLM08 provenance)", () => {
    expect(tierForCodingContextSource("repo-search")).toBe("first-party-workspace");
    expect(CODING_CONTEXT_SOURCE_KINDS).toContain("editor-state");
    expect(tierForCodingContextSource("editor-state")).toBe("first-party-workspace");
    expect(CODING_CONTEXT_SOURCE_KINDS).toContain("git-context");
    expect(tierForCodingContextSource("git-context")).toBe("first-party-workspace");
    expect(tierForCodingContextSource("local-knowledge")).toBe("indexed-knowledge");
    expect(tierForCodingContextSource("memory")).toBe("retained-memory");
    expect(tierForCodingContextSource("quality-intelligence")).toBe("derived-evidence");
  });
});

describe("coding-context budgets (per-keystroke exclusion)", () => {
  it("forbids embedding-cost providers for keystroke-sensitive purposes only", () => {
    expect(embeddingProvidersAllowed("inline")).toBe(false);
    expect(embeddingProvidersAllowed("diagnostic")).toBe(false);
    expect(embeddingProvidersAllowed("completion")).toBe(true);
    expect(embeddingProvidersAllowed("test-generation")).toBe(true);
    expect(embeddingProvidersAllowed("explain")).toBe(true);
  });

  it("defines a positive byte budget and per-source cap for every purpose", () => {
    for (const purpose of CODING_CONTEXT_PURPOSES) {
      const budget = CODING_CONTEXT_BUDGETS[purpose];
      expect(budget.budgetBytes).toBeGreaterThan(0);
      expect(budget.maxBytesPerSource).toBeGreaterThan(0);
      expect(budget.maxBytesPerSource).toBeLessThanOrEqual(budget.budgetBytes);
    }
  });

  it("keeps inline the cheapest budget", () => {
    expect(CODING_CONTEXT_BUDGETS.inline.budgetBytes).toBeLessThan(
      CODING_CONTEXT_BUDGETS.completion.budgetBytes,
    );
  });
});

describe("isCodingContextCitation (content-free guard)", () => {
  it("accepts a well-formed content-free citation", () => {
    expect(isCodingContextCitation(citation())).toBe(true);
    expect(isCodingContextCitation(citation({ citationRef: undefined }))).toBe(true);
    expect(
      isCodingContextCitation(
        citation({ sourceKind: "editor-state", sourceTier: "first-party-workspace" }),
      ),
    ).toBe(true);
  });

  it("rejects any object carrying excerpt content", () => {
    expect(isCodingContextCitation({ ...citation(), text: "secret" })).toBe(false);
    expect(isCodingContextCitation({ ...citation(), excerpt: "secret" })).toBe(false);
    expect(isCodingContextCitation({ ...citation(), content: "secret" })).toBe(false);
  });

  it("rejects malformed citations", () => {
    expect(isCodingContextCitation(null)).toBe(false);
    expect(isCodingContextCitation({ ...citation(), sourceKind: "nope" })).toBe(false);
    expect(isCodingContextCitation({ ...citation(), sourceTier: "nope" })).toBe(false);
    expect(isCodingContextCitation({ ...citation(), score: "high" })).toBe(false);
  });
});

describe("toCodingContextWirePack (content-free projection)", () => {
  const pack: CodingContextPack = {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "completion",
    excerpts: [
      excerpt("const secret = 1;", { id: "a-1", rank: 0 }),
      excerpt("export {}", { id: "a-2", rank: 1 }),
    ],
    usedBytes: 64,
    budgetBytes: 32_768,
    droppedForBudget: 3,
    omissions: [{ sourceKind: "local-knowledge", reason: "not-ready" }],
  };

  it("drops excerpt text and keeps only citations", () => {
    const wire = toCodingContextWirePack(pack);
    expect(wire.entries).toHaveLength(2);
    expect(wire.entries.every((entry) => isCodingContextCitation(entry))).toBe(true);
    expect(JSON.stringify(wire)).not.toContain("secret");
    expect(JSON.stringify(wire)).not.toContain("export {}");
  });

  it("preserves accounting and omissions", () => {
    const wire = toCodingContextWirePack(pack);
    expect(wire.usedBytes).toBe(64);
    expect(wire.budgetBytes).toBe(32_768);
    expect(wire.droppedForBudget).toBe(3);
    expect(wire.omissions).toEqual([{ sourceKind: "local-knowledge", reason: "not-ready" }]);
    expect(wire.purpose).toBe("completion");
  });
});

describe("validateCodingContextRequest", () => {
  it("keeps requests without an editor session link backward-compatible", () => {
    expect(validateCodingContextRequest(validRequest())).toEqual({ ok: true });
    expect(
      validateCodingContextRequest(
        validRequest({
          symbol: "parseConfig",
          queryText: "config parser",
          changedFiles: ["src/a.ts"],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("accepts a non-empty editor session link", () => {
    const request: CodingContextRequest = {
      ...validRequest(),
      editorSessionId: "editor-session-1",
    };

    expect(request.schemaVersion).toBe("1");
    expect(validateCodingContextRequest(request)).toEqual({ ok: true });
  });

  it("bounds editor session links by UTF-8 bytes", () => {
    expect(isBoundedEditorSessionId("a".repeat(256))).toBe(true);
    expect(isBoundedEditorSessionId("\u{1f600}".repeat(64))).toBe(true);
    expect(isBoundedEditorSessionId("\u{1f600}".repeat(65))).toBe(false);
    expect(
      validateCodingContextRequest({
        ...validRequest(),
        editorSessionId: "\u{1f600}".repeat(65),
      }),
    ).toEqual({ ok: false, reasons: ["request.editorSessionId invalid"] });
  });

  it("rejects empty and non-string editor session links", () => {
    for (const editorSessionId of ["", "   ", 7, null]) {
      const result = validateCodingContextRequest({ ...validRequest(), editorSessionId });
      expect(result).toEqual({ ok: false, reasons: ["request.editorSessionId invalid"] });
    }
  });

  it("rejects a non-object", () => {
    expect(validateCodingContextRequest(null).ok).toBe(false);
    expect(validateCodingContextRequest([]).ok).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    const result = validateCodingContextRequest(validRequest({ schemaVersion: "2" as never }));
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an invalid purpose", () => {
    const result = validateCodingContextRequest(validRequest({ purpose: "apply" as never }));
    expect(result.ok).toBe(false);
  });

  it("rejects an empty document path", () => {
    const result = validateCodingContextRequest(validRequest({ documentPath: "   " }));
    expect(result.ok).toBe(false);
  });

  it("rejects malformed optional fields", () => {
    expect(validateCodingContextRequest(validRequest({ symbol: 7 as never })).ok).toBe(false);
    expect(validateCodingContextRequest(validRequest({ changedFiles: [7] as never })).ok).toBe(
      false,
    );
    expect(validateCodingContextRequest(validRequest({ capsuleId: 7 as never })).ok).toBe(false);
  });

  it("rejects ambiguous Local Knowledge scope selectors", () => {
    const result = validateCodingContextRequest(
      validRequest({ capsuleId: "cap-1", capsuleSetId: "set-1" }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reasons).toContain("request.localKnowledgeScope ambiguous");
    }
  });
});

// KEIKO-0159: isRecord, isNonEmptyString, isNonNegativeInteger, isCostClass, isStringArray,
// collectEditorSessionIdError, collectContextErrors, and buildContextSelectors used to be
// re-implemented byte-for-byte in editor-completion.ts, editor-inline-completion.ts, and (all but
// isCostClass) editor-test-generation.ts. They now live here as the single shared implementation
// that all three import instead of carrying their own copy.
describe("shared completion-contract primitives (KEIKO-0159)", () => {
  it("isNonEmptyString is a distinct, non-trimming rule from the editor-session-id / documentPath checks above", () => {
    // A whitespace-only string has length > 0, so the completion contracts' historical `root` /
    // `componentName` semantics accept it -- only isBoundedEditorSessionId and documentPath (both
    // exercised above) reject it via their own trim-sensitive check. Sharing this primitive under
    // the two contracts' existing name must not silently pull in the stricter rule.
    expect(isNonEmptyString("   ")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(7)).toBe(false);
    expect(isBoundedEditorSessionId("   ")).toBe(false);
  });

  it("isRecord / isNonNegativeInteger / isCostClass / isStringArray guard their exact shapes", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isCostClass("medium")).toBe(true);
    expect(isCostClass("huge")).toBe(false);
    expect(isStringArray(["a", "b"])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
  });

  it("collectEditorSessionIdError reports the one shared bounded-bytes message", () => {
    const errors: string[] = [];
    collectEditorSessionIdError("\u{1f600}".repeat(65), errors);
    expect(errors).toEqual([
      `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
    ]);
  });

  it("collectEditorSessionIdError is a no-op for an absent value", () => {
    const errors: string[] = [];
    collectEditorSessionIdError(undefined, errors);
    expect(errors).toEqual([]);
  });

  it("collectContextErrors and buildContextSelectors validate and project the same selector shape", () => {
    const errors: string[] = [];
    collectContextErrors({ queryText: "q", changedFiles: ["a.ts"] }, errors);
    expect(errors).toEqual([]);
    expect(buildContextSelectors({ queryText: "q", changedFiles: ["a.ts"] })).toEqual({
      queryText: "q",
      changedFiles: ["a.ts"],
    });

    const conflicting: string[] = [];
    collectContextErrors({ capsuleId: "a", capsuleSetId: "b" }, conflicting);
    expect(conflicting).toContain("context must not set both capsuleId and capsuleSetId");
  });
});
