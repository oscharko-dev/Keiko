import { describe, expect, it } from "vitest";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type {
  ConnectedContextPack,
  ContextExcerpt,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import { attachCitationsToAnswer } from "@oscharko-dev/keiko-local-knowledge";
import {
  DEFAULT_ENTAILMENT_OPTIONS,
  GROUNDED_NO_EVIDENCE_ANSWER,
  buildPackCitationIndex,
  buildPackExcerptTextResolver,
  type EntailmentJudge,
  type EntailmentJudgeInput,
  type EntailmentVerdict,
  entailmentUnavailableMarker,
  incompleteAnswerMarker,
  missingCitationMarker,
  packExcerptCount,
  packHasUsableEvidence,
  packsHaveUsableEvidence,
  parseInlineCitations,
  reconcileClaimEntailment,
  reconcileInlineCitations,
  reconcileNumericCitations,
  segmentCitedClaims,
  splitClaimSpans,
  stripInlineCitations,
  unsupportedCitationMarker,
  unsupportedClaimMarker,
  unsupportedNumericCitationMarker,
} from "./grounded-faithfulness.js";

const NOW = 1_700_000_000_000;

function excerpt(scopePath: string, startLine: number, endLine: number): ContextExcerpt {
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: `${scopePath}:${String(startLine)}`,
      scopePath,
      lineRange: { startLine, endLine },
      score: 1,
      provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "fp" },
      redactionState: "redacted",
      emittedAtMs: NOW,
      ledgerRef: undefined,
    },
    content: `body of ${scopePath}`,
    contentBytes: 10,
  };
}

function packWith(
  files: readonly { scopePath: string; excerpts: readonly ContextExcerpt[] }[],
  uncertaintyKinds: readonly string[] = [],
): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-1",
      workspaceRoot: "/repo",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "how does auth work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 10,
      excerptBytesMax: 4096,
      modelInputTokensMax: 4000,
      modelOutputTokensMax: 1000,
      elapsedMsMax: 30000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: files.length,
      excerptBytes: 10,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 1,
      rerankCalls: 0,
    },
    files: files.map((f) => ({
      scopePath: f.scopePath,
      role: "read-only" as const,
      selectionReason: "ranked",
      excerpts: f.excerpts,
    })),
    omitted: [],
    uncertainty: uncertaintyKinds.map((kind) => ({
      kind: kind as "no-evidence",
      claim: `marker ${kind}`,
      impactedAtomIds: [],
      emittedAtMs: NOW,
    })),
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

describe("parseInlineCitations", () => {
  it("extracts [path:line-range] markers and dedupes", () => {
    const cites = parseInlineCitations(
      "The route is defined in [src/http/routes.ts:10-20] and again [src/http/routes.ts:10-20].",
    );
    expect(cites).toHaveLength(1);
    expect(cites[0]?.scopePath).toBe("src/http/routes.ts");
    expect(cites[0]?.lineRange).toEqual({ startLine: 10, endLine: 20 });
  });

  it("parses a single-line ref and a bare path", () => {
    const cites = parseInlineCitations("See [a/b.ts:5] and [c/d.py].");
    const byPath = new Map(cites.map((c) => [c.scopePath, c]));
    expect(byPath.get("a/b.ts")?.lineRange).toEqual({ startLine: 5, endLine: 5 });
    expect(byPath.get("c/d.py")?.lineRange).toBeUndefined();
  });

  it("splits comma-separated refs inside one bracket", () => {
    const cites = parseInlineCitations("[src/a.ts:1-2, src/b.ts:3]");
    expect(cites.map((c) => c.scopePath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("preserves valid Unicode, whitespace, and parenthesized repository paths", () => {
    const cites = parseInlineCitations(
      "Siehe [src/Über uns/Bestellung (neu).ts:12-14] und [docs/日本語.md:3].",
    );

    expect(cites).toEqual([
      {
        raw: "src/Über uns/Bestellung (neu).ts:12-14",
        scopePath: "src/Über uns/Bestellung (neu).ts",
        lineRange: { startLine: 12, endLine: 14 },
      },
      {
        raw: "docs/日本語.md:3",
        scopePath: "docs/日本語.md",
        lineRange: { startLine: 3, endLine: 3 },
      },
    ]);
  });

  it("does NOT treat prose brackets, footnotes, or markdown links as citations", () => {
    expect(parseInlineCitations("footnote [1] and a list [a, b, c]")).toHaveLength(0);
    expect(parseInlineCitations("a [markdown link](https://example.com/x)")).toHaveLength(0);
    expect(parseInlineCitations("a [src/readme.md](https://example.com/x)")).toHaveLength(0);
    expect(parseInlineCitations("a [src/readme.md][repository docs]")).toHaveLength(0);
    expect(parseInlineCitations("bracketed [TODO] note")).toHaveLength(0);
  });

  it("rejects non-positive, reversed, and unsafe line ranges", () => {
    expect(
      parseInlineCitations(
        "Invalid [src/a.ts:0], [src/b.ts:20-10], and [src/c.ts:9007199254740992].",
      ),
    ).toEqual([]);
  });
});

describe("reconcileInlineCitations", () => {
  it("flags a citation whose path is NOT in the retrieved pack", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]),
    ]);
    const result = reconcileInlineCitations(
      "Answer grounded in [src/a.ts:1-5] but also fabricates [src/secret/keys.ts:40-55].",
      index,
    );
    expect(result.unsupported.map((c) => c.scopePath)).toEqual(["src/secret/keys.ts"]);
    expect([...result.citedScopePaths]).toEqual(["src/a.ts"]);
  });

  it("accepts a cited path with no line range when the path is present", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]),
    ]);
    const result = reconcileInlineCitations("Grounded in [src/a.ts].", index);
    expect(result.unsupported).toHaveLength(0);
    expect([...result.citedScopePaths]).toEqual(["src/a.ts"]);
  });

  it("does not validate an exact line against path-level evidence with no line window", () => {
    const pathLevel = excerpt("src/a.ts", 1, 5);
    const index = buildPackCitationIndex([
      packWith([
        {
          scopePath: "src/a.ts",
          excerpts: [{ ...pathLevel, atom: { ...pathLevel.atom, lineRange: undefined } }],
        },
      ]),
    ]);

    const result = reconcileInlineCitations("Unverifiable location [src/a.ts:3].", index);

    expect(result.unsupported.map((citation) => citation.raw)).toEqual(["src/a.ts:3"]);
    expect([...result.citedScopePaths]).toEqual([]);
  });

  it("flags a line range wholly outside every excerpt window for a present path", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]),
    ]);
    const result = reconcileInlineCitations("Claim in [src/a.ts:900-950].", index);
    expect(result.unsupported.map((c) => c.scopePath)).toEqual(["src/a.ts"]);
  });

  it("flags a citation that only overlaps but is not contained by an evidence window", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 10, 20)] }]),
    ]);
    const result = reconcileInlineCitations("Overbroad claim [src/a.ts:1-1000].", index);

    expect(result.unsupported.map((citation) => citation.raw)).toEqual(["src/a.ts:1-1000"]);
    expect([...result.citedScopePaths]).toEqual([]);
  });

  it("accepts a citation fully covered by adjacent evidence windows", () => {
    const index = buildPackCitationIndex([
      packWith([
        {
          scopePath: "src/a.ts",
          excerpts: [excerpt("src/a.ts", 1, 10), excerpt("src/a.ts", 11, 20)],
        },
      ]),
    ]);
    const result = reconcileInlineCitations("Joined evidence [src/a.ts:5-15].", index);

    expect(result.unsupported).toEqual([]);
    expect([...result.citedScopePaths]).toEqual(["src/a.ts"]);
  });

  it("does not join adjacent windows that came from different source packs", () => {
    const first = packWith([
      { scopePath: "src/shared.ts", excerpts: [excerpt("src/shared.ts", 1, 10)] },
    ]);
    const secondBase = packWith([
      { scopePath: "src/shared.ts", excerpts: [excerpt("src/shared.ts", 11, 20)] },
    ]);
    const second = {
      ...secondBase,
      stableId: "pack-2",
      scope: { ...secondBase.scope, scopeId: "cs-2", workspaceRoot: "/other-repo" },
    };
    const result = reconcileInlineCitations(
      "Cross-source join [src/shared.ts:5-15].",
      buildPackCitationIndex([first, second]),
    );

    expect(result.unsupported.map((citation) => citation.raw)).toEqual(["src/shared.ts:5-15"]);
    expect([...result.citedScopePaths]).toEqual([]);
  });

  it("uses an explicit source ordinal to disambiguate identical repository paths", () => {
    const first = packWith([
      { scopePath: "src/shared.ts", excerpts: [excerpt("src/shared.ts", 1, 10)] },
    ]);
    const second = packWith([
      { scopePath: "src/shared.ts", excerpts: [excerpt("src/shared.ts", 11, 20)] },
    ]);
    const answer = "Second source only [source:2|src/shared.ts:11-20].";

    expect(parseInlineCitations(answer)).toEqual([
      {
        raw: "source:2|src/shared.ts:11-20",
        sourceId: "2",
        scopePath: "src/shared.ts",
        lineRange: { startLine: 11, endLine: 20 },
      },
    ]);
    const result = reconcileInlineCitations(answer, buildPackCitationIndex([first, second]));
    expect(result.unsupported).toEqual([]);
    expect([...result.citedScopePaths]).toEqual(["src/shared.ts"]);
  });

  it("returns no unsupported markers when every citation is supported", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 20)] }]),
    ]);
    const result = reconcileInlineCitations("Grounded in [src/a.ts:5-10].", index);
    expect(result.unsupported).toHaveLength(0);
    expect(unsupportedCitationMarker(result.unsupported, NOW)).toBeUndefined();
  });
});

describe("unsupportedCitationMarker", () => {
  it("builds an unsupported-citation marker naming the fabricated sources", () => {
    const marker = unsupportedCitationMarker(
      [{ raw: "x", scopePath: "src/x.ts", lineRange: undefined }],
      NOW,
    );
    expect(marker?.kind).toBe("unsupported-citation");
    expect(marker?.claim).toContain("src/x.ts");
  });

  it("builds a body-free warning when source-backed output omits citations", () => {
    expect(missingCitationMarker(NOW)).toEqual({
      kind: "unsupported-citation",
      claim:
        "The answer used retrieved evidence without a supported inline citation. Treat its " +
        "source-backed claims as unverified.",
      impactedAtomIds: [],
      emittedAtMs: NOW,
    });
  });
});

// Minimal real reference for the attacher/reconciler drift pin, mirroring the fixture shape in
// packages/keiko-local-knowledge/src/conversation/citation-attacher.test.ts.
function driftPinReference(): RetrievalReference {
  return {
    chunkId: "ch-a" as RetrievalReference["chunkId"],
    capsuleId: "cap" as KnowledgeCapsuleId,
    score: 0.9,
    citation: {
      documentId: "doc-ch-a" as RetrievalReference["citation"]["documentId"],
      capsuleId: "cap" as KnowledgeCapsuleId,
      sourceId: "src" as RetrievalReference["citation"]["sourceId"],
      chunkId: "ch-a" as RetrievalReference["chunkId"],
      safeDisplayName: "display-ch-a",
    },
  };
}

describe("numeric citation reconciliation", () => {
  it("keeps known markers and reports each unknown marker once", () => {
    const result = reconcileNumericCitations(
      "Known [1], unknown [99], repeated [99], and known [2].",
      new Set([1, 2]),
    );

    expect([...result.citedMarkers]).toEqual([1, 2]);
    expect(result.unsupportedMarkers).toEqual([99]);
    expect(unsupportedNumericCitationMarker(result.unsupportedMarkers, NOW)?.claim).toContain(
      "[99]",
    );
  });

  it("reads every bracket glyph the citation attacher accepts", () => {
    // gpt-oss-style CJK lenticular, fullwidth, and mismatched pairs — the attacher's documented
    // tolerance grammar. A reconciler narrower than that grammar cannot see a dropped marker.
    const result = reconcileNumericCitations(
      "Known 【1】, fullwidth ［7］, and mismatched [9】.",
      new Set([1]),
    );

    expect([...result.citedMarkers]).toEqual([1]);
    expect(result.unsupportedMarkers).toEqual([7, 9]);
  });

  it("stays in lockstep with the attacher's marker grammar", () => {
    const answer = "Alpha 【1】 beta ［2］ gamma [3】.";
    const attached = attachCitationsToAnswer(answer, [driftPinReference()]);
    const attachedMarkers = new Set(attached.citations.map((citation) => citation.index));
    const numeric = reconcileNumericCitations(answer, attachedMarkers);

    // The attacher keeps the in-range 【1】 and drops ［2］/[3】; every glyph shape it parses
    // must be visible to the reconciliation, so the dropped markers surface as unsupported.
    expect([...attachedMarkers]).toEqual([1]);
    expect([...numeric.citedMarkers]).toEqual([1]);
    expect(numeric.unsupportedMarkers).toEqual([2, 3]);
  });
});

describe("incompleteAnswerMarker", () => {
  it("marks a truncated completion", () => {
    expect(incompleteAnswerMarker(NOW).kind).toBe("incomplete-answer");
  });
});

describe("packHasUsableEvidence / packsHaveUsableEvidence", () => {
  it("is false for a pack with zero excerpts", () => {
    const empty = packWith([], ["no-evidence"]);
    expect(packExcerptCount(empty)).toBe(0);
    expect(packHasUsableEvidence(empty)).toBe(false);
  });

  it("is true for a pack with at least one excerpt (even if a stray no-evidence marker is present)", () => {
    const pack = packWith(
      [{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }],
      ["no-evidence"],
    );
    expect(packHasUsableEvidence(pack)).toBe(true);
  });

  it("packsHaveUsableEvidence is true when any pack has evidence", () => {
    const empty = packWith([]);
    const full = packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]);
    expect(packsHaveUsableEvidence([empty, empty])).toBe(false);
    expect(packsHaveUsableEvidence([empty, full])).toBe(true);
  });
});

describe("GROUNDED_NO_EVIDENCE_ANSWER", () => {
  it("is a safe, source-neutral abstention message", () => {
    expect(GROUNDED_NO_EVIDENCE_ANSWER.toLowerCase()).toContain("could not find");
    expect(GROUNDED_NO_EVIDENCE_ANSWER).not.toContain("/");
  });
});

// ─── Entailment (citation-support) verification (Issue #2563) ───────────────────

function excerptWith(
  scopePath: string,
  startLine: number,
  endLine: number,
  content: string,
): ContextExcerpt {
  return { ...excerpt(scopePath, startLine, endLine), content, contentBytes: content.length };
}

// Deterministic scripted judge: the excerpt text declares the verdict via an inline token, so the
// tests score the REAL segmentation/reconciliation logic without any network (same port the gateway
// judge implements). No token ⇒ `supported` (the default happy path).
function scriptedJudge(): EntailmentJudge {
  return {
    judge: (input: EntailmentJudgeInput): Promise<EntailmentVerdict> => {
      if (input.excerptText.includes("[[UNAVAIL]]")) return Promise.resolve("unavailable");
      if (input.excerptText.includes("[[CONTRADICTS]]")) return Promise.resolve("unsupported");
      return Promise.resolve("supported");
    },
  };
}

describe("splitClaimSpans", () => {
  it("splits on sentence boundaries but never inside a [citation]", () => {
    const spans = splitClaimSpans(
      "Auth lives in [src/auth/login.ts:1-9]. It rotates tokens daily.",
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]).toContain("[src/auth/login.ts:1-9]");
    expect(spans[1]).toContain("rotates tokens");
  });

  it("keeps a dotted path in one span (does not split at the file extension dot)", () => {
    const spans = splitClaimSpans("See [src/config/env.ts:3] for details.");
    expect(spans).toHaveLength(1);
  });

  it("splits on newlines for bulleted answers", () => {
    const spans = splitClaimSpans("- first [a/b.ts:1]\n- second [c/d.ts:2]");
    expect(spans).toHaveLength(2);
  });
});

describe("stripInlineCitations", () => {
  it("removes citation brackets and collapses whitespace", () => {
    expect(stripInlineCitations("Login validates in [src/auth/login.ts:10-20] the session.")).toBe(
      "Login validates in the session.",
    );
  });
});

describe("segmentCitedClaims", () => {
  it("returns only spans that carry a citation, with brackets stripped from the claim text", () => {
    const claims = segmentCitedClaims(
      "The service authenticates users. Login validates in [src/auth/login.ts:10-20].",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimText).toBe("Login validates in .");
    expect(claims[0]?.citations.map((c) => c.scopePath)).toEqual(["src/auth/login.ts"]);
  });
});

describe("buildPackExcerptTextResolver", () => {
  const resolver = buildPackExcerptTextResolver([
    packWith([
      {
        scopePath: "src/a.ts",
        excerpts: [
          excerptWith("src/a.ts", 1, 10, "alpha window content"),
          excerptWith("src/a.ts", 40, 55, "beta window content"),
        ],
      },
    ]),
  ]);

  it("returns the overlapping window's content for a line-scoped citation", () => {
    expect(
      resolver({ raw: "x", scopePath: "src/a.ts", lineRange: { startLine: 2, endLine: 6 } }),
    ).toBe("alpha window content");
  });

  it("concatenates all windows for a bare-path citation", () => {
    const text = resolver({ raw: "x", scopePath: "src/a.ts", lineRange: undefined });
    expect(text).toContain("alpha window content");
    expect(text).toContain("beta window content");
  });

  it("returns undefined for a path absent from the pack", () => {
    expect(
      resolver({ raw: "x", scopePath: "src/missing.ts", lineRange: undefined }),
    ).toBeUndefined();
  });

  it("resolves duplicate paths only within the explicitly named source", () => {
    const sourceAwareResolver = buildPackExcerptTextResolver([
      packWith([
        {
          scopePath: "src/shared.ts",
          excerpts: [excerptWith("src/shared.ts", 1, 10, "first source content")],
        },
      ]),
      packWith([
        {
          scopePath: "src/shared.ts",
          excerpts: [excerptWith("src/shared.ts", 1, 10, "second source content")],
        },
      ]),
    ]);
    const qualified = parseInlineCitations("[source:2|src/shared.ts:1-10]")[0];
    const ambiguous = parseInlineCitations("[src/shared.ts:1-10]")[0];
    if (qualified === undefined || ambiguous === undefined) throw new Error("expected citations");

    expect(sourceAwareResolver(qualified)).toBe("second source content");
    expect(sourceAwareResolver(ambiguous)).toBeUndefined();
  });
});

describe("reconcileClaimEntailment", () => {
  function judgeFixturePack(content: string): ReturnType<typeof buildPackExcerptTextResolver> {
    return buildPackExcerptTextResolver([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerptWith("src/a.ts", 1, 20, content)] }]),
    ]);
  }

  it("flags a claim whose in-pack (membership-valid) excerpt does NOT support it", async () => {
    // The citation passes membership (it IS in the pack) but the excerpt contradicts the claim —
    // the exact gap membership reconciliation is blind to ("10 years" cited to a "30 days" excerpt).
    const answer = "The retention period is ten years [src/a.ts:1-20].";
    const resolve = judgeFixturePack("retention period: 30 days [[CONTRADICTS]]");
    const result = await reconcileClaimEntailment(
      answer,
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
    );
    expect(result.unentailed).toHaveLength(1);
    expect(result.unentailed[0]?.citedPaths).toEqual(["src/a.ts"]);
    expect(result.judgedClaims).toBe(1);
  });

  it("passes a claim whose excerpt supports it (no false positive)", async () => {
    const answer = "The retention period is 30 days [src/a.ts:1-20].";
    const resolve = judgeFixturePack("retention period: 30 days");
    const result = await reconcileClaimEntailment(
      answer,
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
    );
    expect(result.unentailed).toHaveLength(0);
    expect(result.judgedClaims).toBe(1);
  });

  it("counts an unavailable verdict without flagging the claim as unsupported", async () => {
    const answer = "Config is read from [src/a.ts:1-20].";
    const resolve = judgeFixturePack("[[UNAVAIL]]");
    const result = await reconcileClaimEntailment(
      answer,
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
    );
    expect(result.unentailed).toHaveLength(0);
    expect(result.unavailableClaims).toBe(1);
  });

  it("never judges a citation that already failed membership (composes without double-report)", async () => {
    const answer = "Claim about [src/ghost.ts:1-3].";
    // membership marks the citation unsupported (out of pack) -> entailment must skip it entirely.
    const membership = reconcileInlineCitations(
      answer,
      buildPackCitationIndex([
        packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]),
      ]),
    );
    let judgeCalls = 0;
    const countingJudge: EntailmentJudge = {
      judge: (): Promise<EntailmentVerdict> => {
        judgeCalls += 1;
        return Promise.resolve("unsupported");
      },
    };
    const result = await reconcileClaimEntailment(
      answer,
      membership,
      buildPackExcerptTextResolver([]),
      countingJudge,
    );
    expect(judgeCalls).toBe(0);
    expect(result.judgedClaims).toBe(0);
    expect(result.unentailed).toHaveLength(0);
  });

  it("is monotone: strictly more unsupported claims never yields fewer flags", async () => {
    const resolve = judgeFixturePack("[[CONTRADICTS]]");
    const oneBad = await reconcileClaimEntailment(
      "A [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
    );
    const twoBad = await reconcileClaimEntailment(
      "A [src/a.ts:1-20]. B [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
    );
    expect(twoBad.unentailed.length).toBeGreaterThanOrEqual(oneBad.unentailed.length);
    expect(twoBad.unentailed).toHaveLength(2);
  });

  it("honours the per-answer claim budget", async () => {
    const resolve = judgeFixturePack("[[CONTRADICTS]]");
    const answer = "A [src/a.ts:1-20]. B [src/a.ts:1-20]. C [src/a.ts:1-20].";
    const result = await reconcileClaimEntailment(
      answer,
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      scriptedJudge(),
      { maxClaims: 2, maxExcerptChars: 900, maxTotalMs: 20_000 },
    );
    expect(result.judgedClaims).toBe(2);
    // #2670 AC6: a claim beyond the budget is UNDECIDED, never supported. Budget exhaustion must
    // surface the same entailment-unavailable caveat the wall-clock branch below already does,
    // instead of dropping the claim silently and rendering the answer as fully verified.
    expect(result.unavailableClaims).toBe(1);
  });

  it("stops calling the judge and marks remaining claims unavailable when the signal is aborted", async () => {
    // Finding #2063/#2555 review: an already-cancelled request must not run the sequential judge
    // calls. With the caller signal aborted, no judge call is made and every cited claim is counted
    // unavailable (degraded/entailment-unavailable) rather than silently dropped or assumed supported.
    let judgeCalls = 0;
    const countingJudge: EntailmentJudge = {
      judge: (): Promise<EntailmentVerdict> => {
        judgeCalls += 1;
        return Promise.resolve("supported");
      },
    };
    const resolve = judgeFixturePack("retention period: 30 days");
    const result = await reconcileClaimEntailment(
      "A [src/a.ts:1-20]. B [src/a.ts:1-20]. C [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      countingJudge,
      DEFAULT_ENTAILMENT_OPTIONS,
      AbortSignal.abort(),
    );
    expect(judgeCalls).toBe(0);
    expect(result.judgedClaims).toBe(0);
    expect(result.unavailableClaims).toBe(3);
    expect(result.unentailed).toHaveLength(0);
  });

  it("leaves the pass unbounded (judge runs per claim) when maxTotalMs is non-positive", async () => {
    // maxTotalMs <= 0 opts out of the stage-wide deadline: every claim is judged, bounded only by
    // maxClaims. Pins that the budget is additive, never a behavior change for a zero budget.
    let judgeCalls = 0;
    const countingJudge: EntailmentJudge = {
      judge: (): Promise<EntailmentVerdict> => {
        judgeCalls += 1;
        return Promise.resolve("supported");
      },
    };
    const resolve = judgeFixturePack("retention period: 30 days");
    const result = await reconcileClaimEntailment(
      "A [src/a.ts:1-20]. B [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      countingJudge,
      { maxClaims: 8, maxExcerptChars: 900, maxTotalMs: 0 },
    );
    expect(judgeCalls).toBe(2);
    expect(result.judgedClaims).toBe(2);
  });

  it("caps the total wall-clock via maxTotalMs when the judge stalls past the budget", async () => {
    // A judge that never resolves on its own: the stage-wide deadline aborts the in-flight call,
    // the judge fails closed to unavailable on abort, and the remaining claims are counted unavailable
    // — so the whole pass is bounded by maxTotalMs instead of maxClaims sequential 30s timeouts.
    const stallingJudge: EntailmentJudge = {
      judge: (_input, signal): Promise<EntailmentVerdict> =>
        new Promise((resolveVerdict) => {
          signal?.addEventListener("abort", () => {
            resolveVerdict("unavailable");
          });
        }),
    };
    const resolve = judgeFixturePack("retention period: 30 days");
    const result = await reconcileClaimEntailment(
      "A [src/a.ts:1-20]. B [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      stallingJudge,
      { maxClaims: 8, maxExcerptChars: 900, maxTotalMs: 10 },
    );
    expect(result.unavailableClaims).toBeGreaterThan(0);
    expect(result.unentailed).toHaveLength(0);
  });
});

describe("unsupportedClaimMarker / entailmentUnavailableMarker", () => {
  it("names the unsupported paths and returns undefined when nothing is unentailed", () => {
    expect(unsupportedClaimMarker([], NOW)).toBeUndefined();
    const marker = unsupportedClaimMarker([{ citedPaths: ["src/x.ts"] }], NOW);
    expect(marker?.kind).toBe("unsupported-claim");
    expect(marker?.claim).toContain("src/x.ts");
    expect(marker?.claim.toLowerCase()).toContain("unverified");
  });

  it("emits a WARN entailment-unavailable marker without any body text", () => {
    const marker = entailmentUnavailableMarker(NOW);
    expect(marker.kind).toBe("entailment-unavailable");
    expect(marker.claim.toLowerCase()).toContain("could not be verified");
  });
});
