// Tests for per-candidate signal extraction (Issue #182). Pure-function checks for the
// table-fixed signal names, deterministic ordering, generated-path detection, and the
// stacktrace-position regex.

import { describe, expect, it } from "vitest";

import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";

import type { SearchAnchor } from "../planner/index.js";

import { DEFAULT_GENERATED_PATTERNS, extractSignals, type RankingHints } from "./signals.js";

const REQUIRED_HINTS: Required<RankingHints> = {
  generatedPathPatterns: DEFAULT_GENERATED_PATTERNS,
  duplicateOf: new Map<string, string>(),
};

function atom(scopePath: string, score: number): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `atom-${scopePath}-${score.toString()}`,
    scopePath,
    lineRange: undefined,
    score,
    provenance: {
      kind: "lexical-search",
      tool: "ripgrep",
      queryFingerprint: "fp",
    },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function anchor(term: string, kind: SearchAnchor["kind"], weight = 0.7): SearchAnchor {
  return { term, kind, weight };
}

const SIGNAL_NAME_ORDER: readonly string[] = [
  "provenance-best-score",
  "provenance-count",
  "anchor-overlap",
  "path-depth-affinity",
  "test-pair-bonus",
  "stacktrace-position-bonus",
  "generated-penalty",
];

describe("extractSignals", () => {
  it("returns all-zero signals and baseScore 0 for empty atoms", () => {
    const result = extractSignals([], [], REQUIRED_HINTS);
    expect(result.scopePath).toBe("");
    for (const signal of result.signals) {
      expect(signal.value).toBe(0);
    }
    expect(result.baseScore).toBe(0);
    expect(result.generatedHint).toBe(false);
  });

  it("emits every signal name in the declared order", () => {
    const result = extractSignals([atom("src/foo.ts", 0.5)], [], REQUIRED_HINTS);
    expect(result.signals.map((s) => s.name)).toEqual(SIGNAL_NAME_ORDER);
  });

  it("captures provenance-best-score = 1 for a single max atom", () => {
    const result = extractSignals([atom("src/foo.ts", 1)], [], REQUIRED_HINTS);
    const best = result.signals.find((s) => s.name === "provenance-best-score");
    expect(best?.value).toBe(1);
  });

  it("anchor-overlap is positive when an anchor term appears in the path", () => {
    const result = extractSignals(
      [atom("src/foo/bar.ts", 0.4)],
      [anchor("bar", "identifier")],
      REQUIRED_HINTS,
    );
    const overlap = result.signals.find((s) => s.name === "anchor-overlap");
    expect(overlap).toBeDefined();
    expect((overlap?.value ?? 0) > 0).toBe(true);
  });

  it("marks a generated path with generatedHint and a -1 generated-penalty signal", () => {
    const result = extractSignals([atom("src/dist/foo.js", 0.5)], [], REQUIRED_HINTS);
    expect(result.generatedHint).toBe(true);
    const penalty = result.signals.find((s) => s.name === "generated-penalty");
    expect(penalty?.value).toBe(-1);
  });

  it("detects a root-level generated directory (no leading slash in scopePath)", () => {
    // Copilot review on PR #251: DEFAULT_GENERATED_PATTERNS uses "/dist/" but scopePath is
    // workspace-relative ("dist/foo.js"), so a substring match alone would miss the root case.
    const result = extractSignals([atom("dist/foo.js", 0.5)], [], REQUIRED_HINTS);
    expect(result.generatedHint).toBe(true);
  });

  it("stacktrace-position-bonus fires when a quoted anchor mentions the path", () => {
    const result = extractSignals(
      [atom("src/foo.ts", 0.3)],
      [anchor("at runFoo (src/foo.ts:42:5)", "quoted")],
      REQUIRED_HINTS,
    );
    const bonus = result.signals.find((s) => s.name === "stacktrace-position-bonus");
    expect(bonus?.value).toBe(1);
  });

  it("stacktrace-position-bonus matches case-insensitively against scopePath", () => {
    // Copilot review on PR #251: planner anchors are lowercased, so a case-sensitive equality
    // would miss legitimate matches when the source file has uppercase characters.
    const result = extractSignals(
      [atom("src/MyClass.ts", 0.3)],
      [anchor("at run (src/myclass.ts:42:5)", "quoted")],
      REQUIRED_HINTS,
    );
    const bonus = result.signals.find((s) => s.name === "stacktrace-position-bonus");
    expect(bonus?.value).toBe(1);
  });

  it("test-pair-bonus fires when path is .test.ts and a path anchor references the source", () => {
    const result = extractSignals(
      [atom("src/foo.test.ts", 0.3)],
      [anchor("src/foo.ts", "path")],
      REQUIRED_HINTS,
    );
    const bonus = result.signals.find((s) => s.name === "test-pair-bonus");
    expect(bonus?.value).toBe(1);
  });

  it("test-pair-bonus matches path anchors case-insensitively", () => {
    const result = extractSignals(
      [atom("src/MyClass.test.ts", 0.3)],
      [anchor("src/myclass.ts", "path")],
      REQUIRED_HINTS,
    );
    const bonus = result.signals.find((s) => s.name === "test-pair-bonus");
    expect(bonus?.value).toBe(1);
  });

  it("path-depth-affinity is higher for shallower paths", () => {
    const shallow = extractSignals([atom("src/foo.ts", 0.5)], [], REQUIRED_HINTS);
    const deep = extractSignals([atom("src/a/b/c/d/e/f/g.ts", 0.5)], [], REQUIRED_HINTS);
    const shallowDepth = shallow.signals.find((s) => s.name === "path-depth-affinity");
    const deepDepth = deep.signals.find((s) => s.name === "path-depth-affinity");
    expect((shallowDepth?.value ?? 0) > (deepDepth?.value ?? 0)).toBe(true);
  });

  it("provenance-count clamps at ten atoms (saturates to 1)", () => {
    const atoms: EvidenceAtom[] = [];
    for (let i = 0; i < 15; i += 1) {
      atoms.push(atom("src/foo.ts", 0.1));
    }
    const result = extractSignals(atoms, [], REQUIRED_HINTS);
    const count = result.signals.find((s) => s.name === "provenance-count");
    expect(count?.value).toBe(1);
  });

  it("is deterministic across consecutive calls", () => {
    const atoms = [atom("src/foo.ts", 0.4), atom("src/foo.ts", 0.7)];
    const anchors = [anchor("foo", "identifier"), anchor("src/foo.ts", "path")];
    const first = extractSignals(atoms, anchors, REQUIRED_HINTS);
    const second = extractSignals(atoms, anchors, REQUIRED_HINTS);
    expect(first).toEqual(second);
  });

  it("clamps baseScore into [0,1] even when penalties dominate", () => {
    const result = extractSignals([atom("src/dist/foo.js", 0.05)], [], REQUIRED_HINTS);
    expect(result.baseScore >= 0).toBe(true);
    expect(result.baseScore <= 1).toBe(true);
  });
});
