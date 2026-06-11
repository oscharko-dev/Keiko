// Tests for the rankCandidates facade (Issue #182). Verifies deterministic composition of
// signals/scoring/filter, defense-in-depth path validation, and complete diagnostics counters.

import { describe, expect, it } from "vitest";

import {
  CANDIDATE_OMISSION_REASONS,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";

import type { SearchAnchor } from "../planner/index.js";

import { rankCandidates, type RankingOptions } from "./rank.js";

const FIXED_NOW = 1_700_000_000_000;

function fixedNow(): number {
  return FIXED_NOW;
}

function atom(scopePath: string, score: number): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `atom-${scopePath}-${score.toString()}`,
    scopePath,
    lineRange: undefined,
    score,
    provenance: { kind: "lexical-search", tool: "ripgrep", queryFingerprint: "fp" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function anchor(term: string, kind: SearchAnchor["kind"], weight = 0.7): SearchAnchor {
  return { term, kind, weight };
}

const BASE_OPTIONS: RankingOptions = { nowMs: fixedNow };

describe("rankCandidates", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      atoms: [atom("src/foo.ts", 0.7), atom("src/bar.ts", 0.5)],
      anchors: [anchor("foo", "identifier")],
    };
    const a = rankCandidates(input, BASE_OPTIONS);
    const b = rankCandidates(input, BASE_OPTIONS);
    expect(a).toEqual(b);
  });

  it("collapses multiple atoms for the same path into a single CandidateFile", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/foo.ts", 0.4), atom("src/foo.ts", 0.7)],
        anchors: [],
      },
      BASE_OPTIONS,
    );
    expect(result.diagnostics.uniqueCandidates).toBe(1);
    const allPaths = [
      ...result.kept.map((c) => c.scopePath),
      ...result.omitted.map((o) => o.scopePath),
    ];
    expect(allPaths.filter((p) => p === "src/foo.ts").length).toBe(1);
  });

  it("omits a generated path with reason generated", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/dist/foo.js", 0.9)],
        anchors: [anchor("foo", "identifier")],
      },
      BASE_OPTIONS,
    );
    const reasons = result.omitted.map((o) => o.reason);
    expect(reasons.includes("generated")).toBe(true);
  });

  it("omits a near-duplicate via the hints map with reason near-duplicate", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/foo.ts", 0.9)],
        anchors: [anchor("foo", "identifier")],
        hints: { duplicateOf: new Map([["src/foo.ts", "src/foo-original.ts"]]) },
      },
      BASE_OPTIONS,
    );
    const reasons = result.omitted.map((o) => o.reason);
    expect(reasons.includes("near-duplicate")).toBe(true);
  });

  it("derives near-duplicate hints for larger same-filename clusters", () => {
    const result = rankCandidates(
      {
        atoms: [
          atom("packages/a/src/client.ts", 0.5),
          atom("packages/b/src/client.ts", 0.95),
          atom("packages/c/src/client.ts", 0.6),
          atom("packages/d/src/client.ts", 0.7),
        ],
        anchors: [anchor("client", "identifier")],
      },
      BASE_OPTIONS,
    );
    expect(result.kept.map((candidate) => candidate.scopePath)).toContain(
      "packages/b/src/client.ts",
    );
    expect(result.diagnostics.omittedCounts["near-duplicate"]).toBe(3);
  });

  it("does not infer near-duplicates for a two-file same-name pair", () => {
    const result = rankCandidates(
      {
        atoms: [atom("packages/a/src/client.ts", 0.8), atom("packages/b/src/client.ts", 0.7)],
        anchors: [anchor("client", "identifier")],
      },
      BASE_OPTIONS,
    );
    expect(result.diagnostics.omittedCounts["near-duplicate"]).toBe(0);
  });

  it("moves maxKept overflow to budget-exhausted", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/a.ts", 0.9), atom("src/b.ts", 0.9), atom("src/c.ts", 0.9)],
        anchors: [],
      },
      {
        ...BASE_OPTIONS,
        filter: { ...{ minScore: 0, maxKept: 1, omitGenerated: true, omitNearDuplicates: true } },
      },
    );
    const reasons = result.omitted.map((o) => o.reason);
    expect(reasons.filter((r) => r === "budget-exhausted").length).toBe(2);
    expect(result.kept.length).toBe(1);
  });

  it("counts invalid scope paths without exposing them as omitted entries", () => {
    const bad: EvidenceAtom = { ...atom("../escape.ts", 0.9), scopePath: "../escape.ts" };
    const result = rankCandidates({ atoms: [bad], anchors: [] }, BASE_OPTIONS);
    expect(result.omitted).toEqual([]);
    expect(result.diagnostics.omittedCounts["outside-scope"]).toBe(1);
  });

  it("initialises every omission-reason counter to 0 and counts each omission", () => {
    const result = rankCandidates(
      { atoms: [atom("src/dist/foo.js", 0.9)], anchors: [] },
      BASE_OPTIONS,
    );
    for (const reason of CANDIDATE_OMISSION_REASONS) {
      expect(typeof result.diagnostics.omittedCounts[reason]).toBe("number");
      expect(result.diagnostics.omittedCounts[reason] >= 0).toBe(true);
    }
    expect(result.diagnostics.omittedCounts.generated).toBe(1);
  });

  it("diagnostics.elapsedMs is non-negative", () => {
    let tick = 100;
    const nowMs = (): number => {
      const value = tick;
      tick += 5;
      return value;
    };
    const result = rankCandidates({ atoms: [atom("src/foo.ts", 0.5)], anchors: [] }, { nowMs });
    expect(result.diagnostics.elapsedMs >= 0).toBe(true);
  });

  it("high-signal exact match outranks a low-signal broad atom", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/foo.ts", 0.95), atom("src/utils/misc.ts", 0.2)],
        anchors: [anchor("foo", "identifier"), anchor("src/foo.ts", "path")],
      },
      BASE_OPTIONS,
    );
    expect(result.kept[0]?.scopePath).toBe("src/foo.ts");
  });

  it("reports totalAtoms and uniqueCandidates accurately", () => {
    const result = rankCandidates(
      {
        atoms: [atom("src/foo.ts", 0.5), atom("src/foo.ts", 0.7), atom("src/bar.ts", 0.3)],
        anchors: [],
      },
      BASE_OPTIONS,
    );
    expect(result.diagnostics.totalAtoms).toBe(3);
    expect(result.diagnostics.uniqueCandidates).toBe(2);
  });
});
