import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateFile,
  type EvidenceAtom,
  type OmittedContextEntry,
} from "@oscharko-dev/keiko-contracts";

import {
  selectGroundedCandidateFiles,
  selectGroundedEvidenceAtoms,
} from "./grounded-evidence-selection.js";

const NOW = 1_784_653_600_000;

function candidate(scopePath: string, score: number): CandidateFile {
  return { scopePath, score, signals: [], omitted: undefined };
}

function atom(
  scopePath: string,
  score: number,
  startLine: number,
  endLine = startLine,
  suffix = "",
): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `atom-${scopePath}-${String(startLine)}-${String(endLine)}-${suffix}`,
    scopePath,
    lineRange: { startLine, endLine },
    score,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "query",
    },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function pathLevelAtom(scopePath: string, score: number): EvidenceAtom {
  return { ...atom(scopePath, score, 1, 1, "path-level"), lineRange: undefined };
}

describe("selectGroundedCandidateFiles", () => {
  it("keeps the strong implementation and test pair for an exact-symbol-shaped ranking", () => {
    const result = selectGroundedCandidateFiles({
      kept: [
        candidate("scripts/dev-runner.test.mjs", 0.95),
        candidate("scripts/dev-runner.mjs", 0.88),
        candidate("src/readiness.ts", 0.41),
        candidate("src/unrelated.ts", 0.3),
      ],
      omitted: [],
      scopeKind: "workspace-root",
      filesReadMax: 32,
      nowMs: NOW,
    });

    expect(result.kept.map((entry) => entry.scopePath)).toEqual([
      "scripts/dev-runner.test.mjs",
      "scripts/dev-runner.mjs",
    ]);
    expect(result.omitted).toEqual([
      { scopePath: "src/readiness.ts", reason: "low-relevance", omittedAtMs: NOW },
      { scopePath: "src/unrelated.ts", reason: "low-relevance", omittedAtMs: NOW },
    ] satisfies readonly OmittedContextEntry[]);
  });

  it("caps broad workspace evidence while preserving deterministic score order", () => {
    const kept = Array.from({ length: 20 }, (_value, index) =>
      candidate(`src/file-${String(index).padStart(2, "0")}.ts`, 0.5 - index * 0.005),
    );
    const result = selectGroundedCandidateFiles({
      kept,
      omitted: [],
      scopeKind: "workspace-root",
      filesReadMax: 32,
      nowMs: NOW,
    });

    expect(result.kept).toHaveLength(12);
    expect(result.kept.map((entry) => entry.scopePath)).toEqual(
      kept.slice(0, 12).map((entry) => entry.scopePath),
    );
    expect(result.omitted.filter((entry) => entry.reason === "budget-exhausted")).toHaveLength(8);
  });

  it("does not relative-score-filter files the user selected explicitly", () => {
    const result = selectGroundedCandidateFiles({
      kept: [candidate("a.ts", 0.9), candidate("b.ts", 0.2), candidate("c.ts", 0.18)],
      omitted: [],
      scopeKind: "files",
      filesReadMax: 3,
      nowMs: NOW,
    });

    expect(result.kept.map((entry) => entry.scopePath)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.omitted).toEqual([]);
  });
});

describe("selectGroundedEvidenceAtoms", () => {
  it("deduplicates equal ranges and retains context-rich windows beside top scores", () => {
    const atoms = [
      atom("src/target.ts", 0.95, 40, 40, "best"),
      atom("src/target.ts", 0.2, 1, 80, "context"),
      atom("src/target.ts", 0.7, 40, 40, "duplicate"),
      ...Array.from({ length: 16 }, (_value, index) =>
        atom("src/target.ts", 0.8 - index * 0.01, 100 + index, 100 + index, String(index)),
      ),
      pathLevelAtom("src/target.ts", 0.01),
      atom("src/decoy.ts", 1, 1),
    ];

    const selected = selectGroundedEvidenceAtoms(atoms, new Set(["src/target.ts"]), "scope");

    expect(selected).toHaveLength(12);
    expect(selected.some((entry) => entry.lineRange?.startLine === 1)).toBe(true);
    expect(selected.filter((entry) => entry.lineRange?.startLine === 37)).toHaveLength(1);
    expect(selected.some((entry) => entry.lineRange === undefined)).toBe(false);
    expect(selected.some((entry) => entry.scopePath === "src/decoy.ts")).toBe(false);
  });

  it("reserves the discovered definition when high-score decoys exhaust the normal slots", () => {
    const definition = {
      ...atom("src/target.ts", 0.1, 400, 426, "definition"),
      provenance: {
        kind: "structural" as const,
        tool: "discovered-symbol-definition",
        queryFingerprint: "query",
      },
    };
    const atoms = [
      definition,
      atom("src/target.ts", 0.2, 1, 100, "context-a"),
      atom("src/target.ts", 0.2, 150, 250, "context-b"),
      ...Array.from({ length: 20 }, (_value, index) =>
        atom("src/target.ts", 20 - index, 300 + index, 300 + index, `decoy-${String(index)}`),
      ),
    ];

    const selected = selectGroundedEvidenceAtoms(atoms, new Set(["src/target.ts"]), "scope");

    expect(selected).toHaveLength(12);
    expect(selected.some((entry) => entry.provenance.tool === "discovered-symbol-definition")).toBe(
      true,
    );
  });

  it("keeps structural trace evidence when it shares a range with a higher raw score", () => {
    const lexical = atom("src/target.ts", 50, 40, 45, "lexical");
    const definition = {
      ...atom("src/target.ts", 0.1, 40, 45, "definition"),
      provenance: {
        kind: "structural" as const,
        tool: "discovered-symbol-definition",
        queryFingerprint: "query",
      },
    };

    const selected = selectGroundedEvidenceAtoms(
      [lexical, definition],
      new Set(["src/target.ts"]),
      "scope",
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.provenance.tool).toBe("discovered-symbol-definition");
  });

  it("preserves the exact line range returned by semantic retrieval", () => {
    const semantic = {
      ...atom("src/target.ts", 0.9, 42, 42, "semantic"),
      provenance: {
        kind: "model-rerank" as const,
        tool: "repo.semanticSearch:configured-repo-semantic-search",
        queryFingerprint: "query",
      },
    };

    const selected = selectGroundedEvidenceAtoms([semantic], new Set(["src/target.ts"]), "scope");

    expect(selected[0]?.lineRange).toEqual({ startLine: 42, endLine: 42 });
  });
});
