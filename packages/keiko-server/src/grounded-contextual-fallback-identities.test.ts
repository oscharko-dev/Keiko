import { describe, expect, it } from "vitest";
import type {
  ContextPackDiagnostics,
  EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  captureContextualFallbackCandidates,
  currentContextualFallbackOrder,
  currentContextualFallbackGroups,
} from "./grounded-contextual-fallback.js";

function lexicalAtom(scopePath: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `current:${scopePath}`,
    scopePath,
    lineRange: { startLine: 1, endLine: 2 },
    score: 0.1,
    metrics: { lexicalQueryGroupKey: "3" },
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "current-query",
    },
    redactionState: "redacted",
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

function diagnostics(...paths: string[]): ContextPackDiagnostics {
  return {
    rankedCandidates: paths.map((scopePath) => ({
      scopePath,
      bucket: "docs",
      score: 1,
      ecosystem: undefined,
      signals: [],
    })),
  };
}

describe("contextual fallback content identities", () => {
  it("retains same-query content peers beyond the diagnostic preview without adding other groups", () => {
    const current = lexicalAtom("current.md");
    const archive = lexicalAtom("archive.md");
    const unrelated = { ...lexicalAtom("other.md"), metrics: { lexicalQueryGroupKey: "4" } };
    const otherQuery = {
      ...lexicalAtom("other-query.md"),
      provenance: { ...archive.provenance, queryFingerprint: "other-query" },
    };
    const atoms = [archive, unrelated, otherQuery, current];
    const captured = captureContextualFallbackCandidates(atoms, diagnostics("current.md"));
    expect(currentContextualFallbackOrder(captured, atoms)).toEqual(["current.md", "archive.md"]);
    expect([...currentContextualFallbackGroups(captured, atoms)]).toEqual([
      ["current.md", "3"],
      ["archive.md", "3"],
    ]);
    expect(currentContextualFallbackOrder(captured, [current, unrelated, otherQuery])).toEqual([
      "current.md",
    ]);
    expect(
      currentContextualFallbackOrder(captured, [
        current,
        { ...archive, provenance: otherQuery.provenance },
      ]),
    ).toEqual(["current.md"]);
  });

  it.each([undefined, "", "invalid", "C"])(
    "cannot extend a diagnostic seed with a missing or malformed group: %s",
    (group) => {
      const seed = { ...lexicalAtom("seed.md"), metrics: { lexicalQueryGroupKey: group } };
      const peer = { ...lexicalAtom("peer.md"), metrics: { lexicalQueryGroupKey: group } };
      const captured = captureContextualFallbackCandidates([seed, peer], diagnostics("seed.md"));
      expect(currentContextualFallbackOrder(captured, [seed, peer])).toEqual(["seed.md"]);
    },
  );

  it("retains the actual producer's deterministic order with equal candidate scores", () => {
    const atoms = [lexicalAtom("a.md"), lexicalAtom("z.md")];
    const captured = captureContextualFallbackCandidates(atoms, diagnostics("z.md", "a.md"));
    expect(currentContextualFallbackOrder(captured, atoms)).toEqual(["z.md", "a.md"]);
    expect([...currentContextualFallbackGroups(captured, atoms)]).toEqual([
      ["z.md", "3"],
      ["a.md", "3"],
    ]);
    expect(captureContextualFallbackCandidates(atoms, undefined)).toEqual([]);
  });

  it("cannot inherit the position of absent, replaced, path-only, or other-query evidence", () => {
    const atom = lexicalAtom("current.md");
    const captured = captureContextualFallbackCandidates([atom], diagnostics(atom.scopePath));
    for (const changed of [
      { ...atom, stableId: "replaced" },
      { ...atom, scopePath: "other.md" },
      { ...atom, lineRange: undefined },
      { ...atom, provenance: { ...atom.provenance, queryFingerprint: "other-query" } },
      { ...atom, provenance: { ...atom.provenance, tool: "repo.symbolFileDiscovery" } },
    ]) {
      expect(currentContextualFallbackOrder(captured, [changed])).toEqual([]);
      expect(currentContextualFallbackGroups(captured, [changed]).size).toBe(0);
    }
    expect(currentContextualFallbackOrder(captured, [])).toEqual([]);
  });

  it("does not equate positional group keys captured from different queries", () => {
    const first = lexicalAtom("first.md");
    const second = lexicalAtom("second.md");
    const otherQuery = {
      ...second,
      provenance: { ...second.provenance, queryFingerprint: "other-query" },
    };
    const atoms = [first, otherQuery];
    const captured = captureContextualFallbackCandidates(
      atoms,
      diagnostics("first.md", "second.md"),
    );
    expect(currentContextualFallbackOrder(captured, atoms)).toEqual(["first.md", "second.md"]);
    expect(currentContextualFallbackGroups(captured, atoms).size).toBe(0);

    const sameQuery = captureContextualFallbackCandidates(
      [first, second],
      diagnostics("first.md", "second.md"),
    );
    expect([
      ...currentContextualFallbackGroups(sameQuery, [first, second, lexicalAtom("unselected.md")]),
    ]).toEqual([
      ["first.md", "3"],
      ["second.md", "3"],
    ]);
  });

  it("does not borrow lexical diagnostic order for semantic, listing, or structural atoms", () => {
    const atom = lexicalAtom("current.md");
    for (const changed of [
      { ...atom, lineRange: undefined },
      { ...atom, provenance: { ...atom.provenance, tool: "repo.symbolFileDiscovery" } },
      {
        ...atom,
        provenance: { ...atom.provenance, kind: "file-listing" as const, tool: "repo.findFiles" },
      },
    ])
      expect(captureContextualFallbackCandidates([changed], diagnostics(atom.scopePath))).toEqual(
        [],
      );
    const semantic = {
      ...lexicalAtom("other.md"),
      provenance: { ...atom.provenance, tool: "repo.semanticSearch:provider" },
    };
    const captured = captureContextualFallbackCandidates([atom], diagnostics(atom.scopePath));
    expect(
      captureContextualFallbackCandidates([atom, semantic], diagnostics(atom.scopePath)),
    ).toEqual([]);
    expect(currentContextualFallbackOrder(captured, [atom, semantic])).toEqual([]);
    expect(currentContextualFallbackGroups(captured, [atom, semantic]).size).toBe(0);
    expect(captureContextualFallbackCandidates([atom], diagnostics("absent.md"))).toEqual([]);
  });
});
