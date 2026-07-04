import { describe, expect, it } from "vitest";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { ConnectedContextPack, ContextExcerpt } from "@oscharko-dev/keiko-contracts";
import {
  GROUNDED_NO_EVIDENCE_ANSWER,
  buildPackCitationIndex,
  incompleteAnswerMarker,
  packExcerptCount,
  packHasUsableEvidence,
  packsHaveUsableEvidence,
  parseInlineCitations,
  reconcileInlineCitations,
  unsupportedCitationMarker,
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

  it("does NOT treat prose brackets, footnotes, or markdown links as citations", () => {
    expect(parseInlineCitations("footnote [1] and a list [a, b, c]")).toHaveLength(0);
    expect(parseInlineCitations("a [markdown link](https://example.com/x)")).toHaveLength(0);
    expect(parseInlineCitations("bracketed [TODO] note")).toHaveLength(0);
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

  it("flags a line range wholly outside every excerpt window for a present path", () => {
    const index = buildPackCitationIndex([
      packWith([{ scopePath: "src/a.ts", excerpts: [excerpt("src/a.ts", 1, 5)] }]),
    ]);
    const result = reconcileInlineCitations("Claim in [src/a.ts:900-950].", index);
    expect(result.unsupported.map((c) => c.scopePath)).toEqual(["src/a.ts"]);
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
