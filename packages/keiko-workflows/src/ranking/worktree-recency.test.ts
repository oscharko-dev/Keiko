import { describe, expect, it } from "vitest";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { rankCandidates } from "./rank.js";
import { DEFAULT_FILTER_OPTIONS } from "./filter.js";

function atom(scopePath: string, score = 0.5): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: scopePath,
    scopePath,
    score,
    lineRange: undefined,
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "worktree" },
  };
}

describe("bounded worktree recency signal", () => {
  it.each(["targeted-code-search", "diagnostic-search"])(
    "ranks an edited lexical candidate higher under %s",
    (retrievalIntent) => {
      const ranked = rankCandidates({
        atoms: [atom("a/validation.ts"), atom("z/validation.ts")],
        anchors: [{ term: "validation", kind: "identifier", weight: 0.9 }],
        hints: { recentPaths: ["z/validation.ts"] },
        context: { retrievalIntent },
      });
      expect(ranked.kept[0]?.scopePath).toBe("z/validation.ts");
      expect(ranked.kept[0]?.signals).toContainEqual({ name: "git-worktree-recency", value: 1 });
    },
  );

  it("does not make worktree edits authoritative for repository overview", () => {
    const ranked = rankCandidates({
      atoms: [atom("a/validation.ts"), atom("z/validation.ts")],
      anchors: [],
      hints: { recentPaths: ["z/validation.ts"] },
      context: { retrievalIntent: "repository-overview" },
    });
    expect(ranked.kept[0]?.scopePath).toBe("a/validation.ts");
    expect(ranked.kept.flatMap((candidate) => candidate.signals)).not.toContainEqual({
      name: "git-worktree-recency",
      value: 1,
    });
  });

  it("still omits generated and below-floor edited candidates", () => {
    const ranked = rankCandidates(
      {
        atoms: [atom("dist/validation.ts"), atom("z/irrelevant.ts", 0), atom("src/Healthy.ts", 1)],
        anchors: [{ term: "Healthy", kind: "identifier", weight: 1 }],
        hints: { recentPaths: ["dist/validation.ts", "z/irrelevant.ts"] },
        context: { retrievalIntent: "diagnostic-search" },
      },
      { filter: { ...DEFAULT_FILTER_OPTIONS, minScore: DEFAULT_FILTER_OPTIONS.minScore } },
    );
    expect(ranked.kept.map((candidate) => candidate.scopePath)).toEqual(["src/Healthy.ts"]);
  });
});
