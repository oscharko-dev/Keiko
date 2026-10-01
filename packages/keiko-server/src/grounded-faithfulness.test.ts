import { describe, expect, it } from "vitest";
import {
  CITATION_FINDING_LIST_MAX,
  citationFindingTotal,
  citationMarkerIndices,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import type {
  ConnectedContextPack,
  ContextExcerpt,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import { attachCitationsToAnswer } from "@oscharko-dev/keiko-local-knowledge";
import {
  DEFAULT_ENTAILMENT_OPTIONS,
  ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM,
  GROUNDED_NO_EVIDENCE_ANSWER,
  NUMERIC_EVIDENCE_FRAMING_CHARS,
  buildPackCitationIndex,
  buildPackExcerptTextResolver,
  type EntailmentJudge,
  type EntailmentJudgeInput,
  type EntailmentVerdict,
  entailmentUnavailableMarker,
  incompleteAnswerMarker,
  missingCitationMarker,
  missingCitationMarkerFor,
  packExcerptCount,
  packHasUsableEvidence,
  packsHaveUsableEvidence,
  parseInlineCitations,
  reconcileClaimEntailment,
  reconcileInlineCitations,
  reconcileNumericClaimEntailment,
  reconcileNumericCitations,
  segmentCitedClaims,
  segmentNumericCitedClaims,
  splitClaimSpans,
  stripInlineCitations,
  unsupportedCitationMarker,
  unsupportedClaimMarker,
  unsupportedNumericCitationMarker,
  uncitedMemoryContextMarker,
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

  // The reader-facing text for `unsupported-citation` says the answer "references sources that were
  // not in the retrieved evidence". An answer that merely forgot its markers references nothing, so
  // it carries its own kind; the warning body is unchanged.
  it("builds a body-free warning when source-backed output omits citations", () => {
    expect(missingCitationMarker(NOW)).toEqual({
      kind: "uncited-answer",
      claim:
        "The answer used retrieved evidence without a supported inline citation. Treat its " +
        "source-backed claims as unverified.",
      impactedAtomIds: [],
      emittedAtMs: NOW,
    });
    expect(missingCitationMarker(NOW).kind).not.toBe("unsupported-citation");
  });

  it("reports governed memory context outside the evidence as uncited, not as a fabricated citation", () => {
    expect(uncitedMemoryContextMarker(NOW).kind).toBe("uncited-answer");
  });
});

describe("missingCitationMarkerFor", () => {
  it("warns for a substantive answer that carries no citation", () => {
    const marker = missingCitationMarkerFor(
      "Die Anwendungen laufen auf Java 17 und werden mit Maven gebaut.",
      NOW,
    );
    expect(marker?.kind).toBe("uncited-answer");
  });

  it.each([
    "In den bereitgestellten Dokumenten wurden keine Informationen oder Vorgaben zur Java-Version gefunden.",
    "The provided documents do not contain any information about the Java version.",
    "No evidence found in the connected scope.",
  ])("does not warn about a missing citation on the refusal %j", (refusal) => {
    expect(missingCitationMarkerFor(refusal, NOW)).toBeUndefined();
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

  it("reads every index of a grouped marker like the attacher does", () => {
    const answer = "Java 17 wird verwendet [1, 7, 8]. Ein Nachtrag [2; 9].";
    const references = [driftPinReference(), driftPinReference()];
    const attached = attachCitationsToAnswer(answer, references);
    const attachedMarkers = new Set(attached.citations.map((citation) => citation.index));
    const numeric = reconcileNumericCitations(answer, attachedMarkers);

    // The attacher keeps the in-range 1 and 2; the reconciler must SEE the grouped 7, 8 and 9 so
    // they surface as unsupported instead of rendering as dead text with no signal.
    expect([...attachedMarkers]).toEqual([1, 2]);
    expect([...numeric.citedMarkers]).toEqual([1, 2]);
    expect(numeric.unsupportedMarkers).toEqual([7, 8, 9]);
  });

  it("states the total of dangling markers and unentailed claims beyond the listed ones", () => {
    const dangling = Array.from({ length: 12 }, (_, index) => index + 5);
    const numeric = unsupportedNumericCitationMarker(dangling, NOW);
    const claims = unsupportedClaimMarker(
      [{ citedPaths: ["[1]"] }, { citedPaths: ["[1]"] }, { citedPaths: ["[2]"] }],
      NOW,
    );

    // The claim lists at most CITATION_FINDING_LIST_MAX by name and states the total the UI counts.
    expect(citationMarkerIndices(numeric?.claim ?? "")).toHaveLength(CITATION_FINDING_LIST_MAX);
    expect(citationFindingTotal(numeric?.claim ?? "")).toBe(12);
    expect(citationFindingTotal(claims?.claim ?? "")).toBe(3);
    expect(citationFindingTotal(unsupportedNumericCitationMarker([9], NOW)?.claim ?? "")).toBe(1);
  });

  // PR #3678 review: listed paths are untrusted model output; a count syntax inside one must never
  // be read as the marker's total.
  it("reads the producer's terminal total, never one written inside a cited path", () => {
    const unsupported = parseInlineCitations("Claim [src/ (999 in total)/a.ts] and [b.ts].");
    const marker = unsupportedCitationMarker(unsupported, NOW);

    expect(unsupported).toHaveLength(2);
    expect(citationFindingTotal(marker?.claim ?? "")).toBe(2);
    const single = unsupportedCitationMarker(
      parseInlineCitations("Claim [src/ (999 in total)/a.ts]."),
      NOW,
    );
    expect(citationFindingTotal(single?.claim ?? "")).toBe(1);
  });

  // PR #3678 review (P1): a grouped marker whose every index is fabricated is a dangling source
  // attribution and must keep its warning; only Markdown code never cites.
  it("reports fabricated grouped markers and never reads code as a citation", () => {
    const numeric = reconcileNumericCitations(
      "The API uses TLS [1]. The repository enforces MFA [9, 10].",
      new Set([1]),
    );

    expect([...numeric.citedMarkers]).toEqual([1]);
    expect(numeric.unsupportedMarkers).toEqual([9, 10]);
    expect(
      reconcileNumericCitations("Use `a = [5]` and\n```\nb = [6, 7]\n```\n[1].", new Set([1]))
        .unsupportedMarkers,
    ).toEqual([]);
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

describe("numeric citation entailment", () => {
  it("judges a trailing numeric marker against its exact selected excerpt", async () => {
    const result = await reconcileNumericClaimEntailment(
      "Retention is ten years.[1]",
      [{ marker: 1, excerptText: "Retention is 30 days. [[CONTRADICTS]]" }],
      scriptedJudge(),
    );
    expect(result.unentailed).toEqual([{ citedPaths: ["[1]"] }]);
  });

  it("attributes a citation-only trailing marker span to the preceding sentence", async () => {
    const judged: EntailmentJudgeInput[] = [];
    const judge: EntailmentJudge = {
      judge: (input): Promise<EntailmentVerdict> => {
        judged.push(input);
        return Promise.resolve("unsupported");
      },
    };

    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days. [1]",
      [{ marker: 1, excerptText: "Retention is ten years." }],
      judge,
    );

    expect(judged).toEqual([
      { claimText: "Retention is 30 days.", excerptText: "Retention is ten years." },
    ]);
    expect(result).toMatchObject({ judgedClaims: 1, unentailed: [{ citedPaths: ["[1]"] }] });
  });

  it.each([
    ["Retention is 30 days. 【1】", ["[1]"]],
    ["Retention is 30 days. [1] [2]", ["[1]", "[2]"]],
  ] as const)("judges every citation-only trailing marker in %s", async (answer, citedPaths) => {
    const judged: EntailmentJudgeInput[] = [];
    const result = await reconcileNumericClaimEntailment(
      answer,
      [
        { marker: 1, excerptText: "Retention is ten years." },
        { marker: 2, excerptText: "Retention is five years." },
      ],
      {
        judge: (input): Promise<EntailmentVerdict> => {
          judged.push(input);
          return Promise.resolve("unsupported");
        },
      },
    );

    expect(judged).toHaveLength(1);
    expect(judged[0]?.claimText).toBe("Retention is 30 days.");
    expect(result).toMatchObject({ judgedClaims: 1, unentailed: [{ citedPaths }] });
  });

  it("keeps duplicate markers on one claim to one judge call", async () => {
    let calls = 0;
    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days [1][1].",
      [{ marker: 1, excerptText: "Retention is 30 days." }],
      { judge: (): Promise<EntailmentVerdict> => ((calls += 1), Promise.resolve("supported")) },
    );
    expect(result.judgedClaims).toBe(1);
    expect(calls).toBe(1);
  });

  it("judges repeated sentence text with different markers as separate claims", async () => {
    const judged: EntailmentJudgeInput[] = [];
    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days [1]. Retention is 30 days [2].",
      [
        { marker: 1, excerptText: "Retention is ten years. [[CONTRADICTS]]" },
        { marker: 2, excerptText: "Retention is 30 days." },
      ],
      {
        judge: (input): Promise<EntailmentVerdict> => {
          judged.push(input);
          return scriptedJudge().judge(input);
        },
      },
    );

    expect(judged).toHaveLength(2);
    expect(judged.map((input) => input.excerptText)).toEqual([
      "Retention is ten years. [[CONTRADICTS]]",
      "Retention is 30 days.",
    ]);
    expect(result).toMatchObject({ judgedClaims: 2, unentailed: [{ citedPaths: ["[1]"] }] });
  });

  it("keeps a numeric citation with mixed path citations in one judgeable claim", () => {
    expect(
      segmentNumericCitedClaims(
        "Retention is 30 days [docs/policy.md:12] and audits are quarterly [1].",
      ),
    ).toEqual([
      {
        claimText: "Retention is 30 days and audits are quarterly .",
        markers: [1],
      },
    ]);
  });

  it("keeps missing and malformed markers out of semantic evidence", async () => {
    const claims = segmentNumericCitedClaims("Missing [9], malformed [x], and zero [0].");
    // The malformed `[x]` is no citation: the stripper removes text the judge never reads.
    expect(claims).toEqual([
      { claimText: "Missing , malformed , and zero .", markers: [9], hidesProse: true },
    ]);
    const result = await reconcileNumericClaimEntailment(
      "Missing [9], malformed [x], and zero [0].",
      [{ marker: 1, excerptText: "unused" }],
      scriptedJudge(),
    );
    expect(result).toEqual({ unentailed: [], judgedClaims: 0, unavailableClaims: 0 });
  });

  // PR #3678 review (P1): the judge reads the stripped claim, so a claim whose brackets held prose
  // says so; citation markers, path citations and grouped markers hide nothing.
  it("flags a claim whose stripped brackets held prose the judge never reads", () => {
    expect(
      segmentNumericCitedClaims(
        "TLS is used [1, 2]. TLS is used [src/tls.ts:4][src/tls.ts:9] [1]. TLS [The repository enforces MFA] [1]. See the [guide](docs/g.md) [2].",
      ),
    ).toEqual([
      { claimText: "TLS is used .", markers: [1, 2] },
      { claimText: "TLS is used .", markers: [1] },
      { claimText: "TLS .", markers: [1], hidesProse: true },
      { claimText: "See the (docs/g.md) .", markers: [2], hidesProse: true },
    ]);
  });

  it("carries hidden prose into the claim a marker-only span supports", () => {
    expect(
      segmentNumericCitedClaims("The API uses TLS [1]. [The repository enforces MFA] [1]"),
    ).toEqual([{ claimText: "The API uses TLS .", markers: [1], hidesProse: true }]);
  });

  // PR #3678 review (P1): a marker-only span supports the claim before it, hidden prose included,
  // and a Markdown link label is visible prose however path-like it reads.
  it("keeps hidden prose across a bracket-only line, a trailing period and a lone marker", () => {
    expect(segmentNumericCitedClaims("The API uses TLS.\n[MFA mandatory]\n[1]")).toEqual([
      { claimText: "The API uses TLS.", markers: [1], hidesProse: true },
    ]);
    expect(segmentNumericCitedClaims("The API uses TLS [MFA mandatory]. [1].")).toEqual([
      { claimText: "The API uses TLS .", markers: [1], hidesProse: true },
    ]);
    expect(segmentNumericCitedClaims("[MFA mandatory] [1]")).toEqual([
      { claimText: "", markers: [1], hidesProse: true },
    ]);
  });

  it("carries hidden prose into a marker-only continuation and flags a link label", () => {
    expect(segmentNumericCitedClaims("The API uses TLS [MFA mandatory]. [1]")).toEqual([
      { claimText: "The API uses TLS .", markers: [1], hidesProse: true },
    ]);
    expect(
      segmentNumericCitedClaims(
        "The API uses TLS [MFA mandatory / anonymous requests denied](https://example.test) [1].",
      ),
    ).toEqual([
      { claimText: "The API uses TLS (https://example.test) .", markers: [1], hidesProse: true },
    ]);
  });

  it("segments a grouped marker into one claim citing every index", () => {
    expect(segmentNumericCitedClaims("Java 17 wird verwendet [1, 7, 8].")).toEqual([
      { claimText: "Java 17 wird verwendet .", markers: [1, 7, 8] },
    ]);
  });

  // The rendered evidence block is the `[n] label` header plus a code fence around an excerpt the
  // producer already capped at the excerpt limit, so it is LONGER than the excerpt. Measured against
  // the bare 900-character cap it never fit, and every normally cited claim degraded to
  // "citation support could not be verified".
  function renderedBlock(marker: number, excerptChars: number): string {
    const excerpt = "Retention is 30 days. "
      .repeat(Math.ceil(excerptChars / 22))
      .slice(0, excerptChars);
    return `[${String(marker)}] Handbuch · Kapitel 3 · Aufbewahrung\n\`\`\`text\n${excerpt}\n\`\`\``;
  }

  it("judges a normal cited claim whose block wraps an excerpt at the excerpt limit", async () => {
    const block = renderedBlock(1, DEFAULT_ENTAILMENT_OPTIONS.maxExcerptChars);
    expect(block.length).toBeGreaterThan(DEFAULT_ENTAILMENT_OPTIONS.maxExcerptChars);
    let calls = 0;
    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days [1].",
      [{ marker: 1, excerptText: block }],
      { judge: (): Promise<EntailmentVerdict> => ((calls += 1), Promise.resolve("supported")) },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ unentailed: [], judgedClaims: 1, unavailableClaims: 0 });
  });

  it("judges a claim that cites several evidence blocks at once", async () => {
    let judgedText = "";
    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days [1, 2, 3].",
      [1, 2, 3].map((marker) => ({
        marker,
        excerptText: renderedBlock(marker, DEFAULT_ENTAILMENT_OPTIONS.maxExcerptChars),
      })),
      {
        judge: (input): Promise<EntailmentVerdict> => {
          judgedText = input.excerptText;
          return Promise.resolve("supported");
        },
      },
    );
    expect(result).toEqual({ unentailed: [], judgedClaims: 1, unavailableClaims: 0 });
    expect(judgedText).toContain("[1] Handbuch");
    expect(judgedText).toContain("[3] Handbuch");
  });

  it("still refuses to judge a block whose excerpt is longer than the excerpt limit", async () => {
    let calls = 0;
    const oversized = renderedBlock(
      1,
      DEFAULT_ENTAILMENT_OPTIONS.maxExcerptChars + NUMERIC_EVIDENCE_FRAMING_CHARS + 50,
    );
    const result = await reconcileNumericClaimEntailment(
      "Retention is ten years [1].",
      [{ marker: 1, excerptText: `${oversized}\n[[CONTRADICTS]]` }],
      {
        judge: (input): Promise<EntailmentVerdict> => ((calls += 1), scriptedJudge().judge(input)),
      },
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ unentailed: [], judgedClaims: 0, unavailableClaims: 1 });
  });

  it("degrades a claim citing more distinct evidence items than one judge call carries", async () => {
    const markers = Array.from(
      { length: ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM + 1 },
      (_, index) => index + 1,
    );
    let calls = 0;
    const result = await reconcileNumericClaimEntailment(
      `Retention is 30 days [${markers.join(", ")}].`,
      markers.map((marker) => ({
        marker,
        excerptText: `Retention evidence number ${String(marker)}.`,
      })),
      { judge: (): Promise<EntailmentVerdict> => ((calls += 1), Promise.resolve("supported")) },
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ unentailed: [], judgedClaims: 0, unavailableClaims: 1 });
  });

  it("degrades to unavailable when the numeric citation judge cannot decide", async () => {
    const result = await reconcileNumericClaimEntailment(
      "Retention is 30 days 【1】.",
      [{ marker: 1, excerptText: "[[UNAVAIL]]" }],
      scriptedJudge(),
    );
    expect(result).toEqual({ unentailed: [], judgedClaims: 1, unavailableClaims: 1 });
  });
});

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

  it("keeps dotted content inside full-width citation brackets in one span", () => {
    const spans = splitClaimSpans("See ［src/config/env.ts:3］ for details.");
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

  it("removes full-width numeric citation brackets before judging", () => {
    expect(stripInlineCitations("The retention is 30 days ［1］.")).toBe(
      "The retention is 30 days .",
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

  // PR #3678 review (P1): a claim the judge would read only in part is never judged, however well
  // its visible half matches the excerpt; it counts as undecided and names why.
  it("never judges a claim whose bracketed prose the stripper hides", async () => {
    const calls: string[] = [];
    const judge: EntailmentJudge = {
      judge: (input: EntailmentJudgeInput): Promise<EntailmentVerdict> => {
        calls.push(input.claimText);
        return Promise.resolve("supported");
      },
    };
    const path = await reconcileClaimEntailment(
      "The retention period is 30 days [MFA is mandatory] [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      judgeFixturePack("retention period: 30 days"),
      judge,
    );
    const numeric = await reconcileNumericClaimEntailment(
      "The retention period is 30 days [MFA is mandatory] [1].",
      [{ marker: 1, excerptText: "retention period: 30 days" }],
      judge,
    );

    for (const result of [path, numeric]) {
      expect(result).toEqual({
        unentailed: [],
        judgedClaims: 0,
        unavailableClaims: 1,
        hiddenProseClaims: 1,
      });
    }
    expect(calls).toEqual([]);
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

  it("starts independent claim judges concurrently while preserving their verdicts", async () => {
    const pending: ((verdict: EntailmentVerdict) => void)[] = [];
    const delayedJudge: EntailmentJudge = {
      judge: (): Promise<EntailmentVerdict> =>
        new Promise((resolveVerdict) => {
          pending.push(resolveVerdict);
        }),
    };
    const result = reconcileClaimEntailment(
      "A [src/a.ts:1-20]. B [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      judgeFixturePack("retention period: 30 days"),
      delayedJudge,
      { maxClaims: 8, maxExcerptChars: 900, maxTotalMs: 20_000 },
    );

    await Promise.resolve();
    expect(pending).toHaveLength(2);
    for (const resolveVerdict of pending) resolveVerdict("supported");
    await expect(result).resolves.toEqual({
      unentailed: [],
      judgedClaims: 2,
      unavailableClaims: 0,
    });
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

  it("treats a truncated excerpt as unavailable instead of judging a partial excerpt", async () => {
    // The contradicting fact sits past the default 900-char maxExcerptChars cut. If the judge were
    // ever handed the truncated prefix, scriptedJudge's default verdict is "supported" — exactly the
    // silent false-positive this reconciliation exists to prevent. maxClaims/maxTotalMs both already
    // degrade to `unavailable` on their own budget exhaustion; excerpt-character truncation must too.
    const resolve = judgeFixturePack(`${"filler ".repeat(150)}[[CONTRADICTS]]`);
    let judgeCalls = 0;
    const countingJudge: EntailmentJudge = {
      judge: (input): Promise<EntailmentVerdict> => {
        judgeCalls += 1;
        return scriptedJudge().judge(input);
      },
    };
    const result = await reconcileClaimEntailment(
      "The retention period is 30 days [src/a.ts:1-20].",
      { unsupported: [], citedScopePaths: new Set(["src/a.ts"]) },
      resolve,
      countingJudge,
    );
    expect(judgeCalls).toBe(0);
    expect(result.unentailed).toHaveLength(0);
    // The claim was never actually submitted to the judge, so it must not count as judged (the
    // entailment-stage diagnostic reports "unavailable for X of Y judged claims" from this count).
    expect(result.judgedClaims).toBe(0);
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
