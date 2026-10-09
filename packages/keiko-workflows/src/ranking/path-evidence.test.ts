import { describe, expect, it } from "vitest";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchAnchor } from "../planner/index.js";
import { DEFAULT_FILTER_OPTIONS } from "./filter.js";
import { rankCandidates } from "./rank.js";
import { computeScore, DEFAULT_SCORING_WEIGHTS, type ScoringWeights } from "./scoring.js";
import { DEFAULT_GENERATED_PATTERNS, extractSignals, type ExtractedSignals } from "./signals.js";

const DEEP = "src/Form/feature/conditions/deep/validation.ts";
const HINTS = {
  generatedPathPatterns: DEFAULT_GENERATED_PATTERNS,
  duplicateOf: new Map<string, string>(),
};

function atom(scopePath: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `path-evidence-${scopePath}`,
    scopePath,
    score: 0.5,
    lineRange: undefined,
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "path-evidence",
    },
  };
}

function anchor(term: string, kind: SearchAnchor["kind"] = "path", weight = 0.9): SearchAnchor {
  return { term, kind, weight };
}

function signal(path: string, anchors: readonly SearchAnchor[], name: string): number | undefined {
  return extractSignals([atom(path)], anchors, HINTS).signals.find((entry) => entry.name === name)
    ?.value;
}

function vector(signals: ExtractedSignals["signals"]): ExtractedSignals {
  return { scopePath: DEEP, signals, baseScore: 0, generatedHint: false };
}

function zeroWeights(): ScoringWeights {
  return {
    provenanceBestScore: 0,
    provenanceCount: 0,
    anchorOverlap: 0,
    pathDepthAffinity: 0,
    testPairBonus: 0,
    stacktracePositionBonus: 0,
    generatedPenalty: 0,
  };
}

describe("path evidence signals", () => {
  it.each([
    { term: DEEP, expected: 0.9 },
    { term: "feature/conditions/deep/validation.ts", expected: 0.72 },
    { term: "other/validation.ts", expected: 0 },
  ])("scales exact and suffix matches by anchor weight: $term", ({ term, expected }) => {
    expect(signal(DEEP, [anchor(term)], "exact-path-match")).toBeCloseTo(expected, 10);
  });

  it("measures whole directory segments rather than incidental substrings", () => {
    const anchors = [anchor("Feature/Conditions/validation.ts")];
    expect(
      signal("src/feature/elsewhere/validation.ts", anchors, "path-segment-affinity"),
    ).toBeCloseTo(0.45, 10);
    expect(
      signal("src/notfeature/conditionsOld/validation.ts", anchors, "path-segment-affinity"),
    ).toBe(0);
  });

  it("recognizes a weighted dotted basename without equating it to a full path", () => {
    expect(
      signal(DEEP, [anchor("validation.ts", "identifier", 0.7)], "basename-match"),
    ).toBeCloseTo(0.7, 10);
    expect(signal(DEEP, [anchor("validation.ts", "identifier", 0.7)], "exact-path-match")).toBe(0);
  });

  it("weights identifier overlap and reduces incidental prose influence", () => {
    const strong = signal(DEEP, [anchor("validation", "identifier", 0.9)], "anchor-overlap");
    const weak = signal(DEEP, [anchor("validation", "identifier", 0.2)], "anchor-overlap");
    const literal = signal(DEEP, [anchor("validation", "literal", 0.9)], "anchor-overlap");
    expect(strong).toBeGreaterThan(weak ?? 0);
    expect(strong).toBeGreaterThan(literal ?? 0);
    expect(
      signal("src/revalidation.ts", [anchor("validation", "identifier")], "anchor-overlap"),
    ).toBe(0);
  });

  it("neutralizes depth penalties when a positive path signal addresses a deep file", () => {
    expect(signal(DEEP, [anchor(DEEP)], "path-depth-affinity")).toBe(1);
    expect(signal(DEEP, [], "path-depth-affinity")).toBeLessThan(1);
  });

  it("derives directory affinity from the existing paired test/source edge", () => {
    const paired: EvidenceAtom = {
      ...atom(DEEP),
      provenance: {
        kind: "structural",
        tool: "test-source-pairing",
        queryFingerprint: "path-evidence",
      },
      edge: {
        kind: "test-source",
        source: { scopePath: "tests/Form/feature/probe.test.ts" },
        target: { scopePath: DEEP },
        confidence: "resolved",
      },
    };
    const signals = extractSignals([paired], [], HINTS);
    expect(
      signals.signals.find((entry) => entry.name === "path-segment-affinity")?.value,
    ).toBeGreaterThan(0);
  });
});

describe("path evidence scoring", () => {
  it("adds path weights without removing established scoring dimensions", () => {
    expect(DEFAULT_SCORING_WEIGHTS).toMatchObject({
      exactPathMatch: expect.any(Number),
      pathSegmentAffinity: expect.any(Number),
      basenameMatch: expect.any(Number),
    });
    expect(DEFAULT_SCORING_WEIGHTS.provenanceBestScore).toBeGreaterThan(0);
  });

  it("applies the configured exact-path contribution through the production scorer", () => {
    const weights = { ...zeroWeights(), exactPathMatch: 0.4 };
    expect(computeScore(vector([{ name: "exact-path-match", value: 1 }]), weights)).toBeCloseTo(
      0.4,
      10,
    );
  });

  it("derives normalization headroom from added weights while preserving the definition share", () => {
    const weights = {
      ...zeroWeights(),
      symbolDefinition: 0.3,
      exactPathMatch: 0.8,
      pathSegmentAffinity: 0.4,
      basenameMatch: 0.2,
    };
    const common = vector([
      { name: "exact-path-match", value: 1 },
      { name: "path-segment-affinity", value: 1 },
      { name: "basename-match", value: 1 },
    ]);
    const definition = vector([...common.signals, { name: "symbol-definition", value: 1 }]);
    const ordinaryScore = computeScore(common, weights);
    const definitionScore = computeScore(definition, weights);
    expect(ordinaryScore).toBeCloseTo(1 - weights.symbolDefinition, 10);
    expect(definitionScore).toBeCloseTo(1, 10);
    expect(definitionScore - ordinaryScore).toBeCloseTo(weights.symbolDefinition, 10);
  });

  it("ranks a deeper explicit reference ahead of a shallow same-basename decoy", () => {
    const input = Object.assign(
      { atoms: [atom("src/validation.ts"), atom(DEEP)], anchors: [] },
      {
        references: [{ path: DEEP, origin: "query" as const }],
      },
    );
    const result = rankCandidates(input, { filter: { ...DEFAULT_FILTER_OPTIONS, minScore: 0 } });
    expect(result.kept[0]?.scopePath).toBe(DEEP);
    expect(
      result.kept[0]?.signals.find((entry) => entry.name === "exact-path-match")?.value,
    ).toBeGreaterThan(0);
  });
});
