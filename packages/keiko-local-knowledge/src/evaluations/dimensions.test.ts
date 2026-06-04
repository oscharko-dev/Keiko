// Tests for the pure scoring functions (Epic #189, Issue #268). Each dimension has a
// happy-path case, the zero-score case, a partial-score case, and the empty-input case
// that the spec calls out as vacuously 1.0.

import { describe, expect, it } from "vitest";

import type {
  ChunkId,
  CitationReference,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import {
  scoreCitationQuality,
  scoreNoEvidenceAccuracy,
  scorePrecision,
  scoreRecall,
  scoreSourceIsolation,
  type CitationRequirementKey,
} from "./dimensions.js";

function makeRef(
  chunkId: string,
  capsuleId: string,
  citation: Partial<CitationReference> = {},
): RetrievalReference {
  const fullCitation: CitationReference = {
    documentId: citation.documentId ?? ("doc-1" as CitationReference["documentId"]),
    capsuleId: capsuleId as CitationReference["capsuleId"],
    sourceId: citation.sourceId ?? ("src-1" as CitationReference["sourceId"]),
    chunkId: chunkId as CitationReference["chunkId"],
    safeDisplayName: citation.safeDisplayName ?? "sample.txt",
    ...(citation.pageNumber !== undefined ? { pageNumber: citation.pageNumber } : {}),
    ...(citation.pageLabel !== undefined ? { pageLabel: citation.pageLabel } : {}),
    ...(citation.sectionPath !== undefined ? { sectionPath: citation.sectionPath } : {}),
    ...(citation.characterStart !== undefined ? { characterStart: citation.characterStart } : {}),
    ...(citation.characterEnd !== undefined ? { characterEnd: citation.characterEnd } : {}),
  };
  return {
    chunkId: chunkId as ChunkId,
    capsuleId: capsuleId as KnowledgeCapsuleId,
    score: 1.0,
    citation: fullCitation,
  };
}

describe("scoreRecall", () => {
  it("returns 1.0 when every expected chunk is in the returned set", () => {
    const returned = [makeRef("c1", "cap"), makeRef("c2", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId, "c2" as ChunkId];
    expect(scoreRecall(returned, expected)).toBe(1);
  });

  it("returns 0.0 when none of the expected chunks are returned", () => {
    const returned = [makeRef("x1", "cap"), makeRef("x2", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId, "c2" as ChunkId];
    expect(scoreRecall(returned, expected)).toBe(0);
  });

  it("returns the partial-hit ratio", () => {
    const returned = [makeRef("c1", "cap"), makeRef("x1", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId, "c2" as ChunkId];
    expect(scoreRecall(returned, expected)).toBe(0.5);
  });

  it("returns 1.0 vacuously when `expected` is empty", () => {
    const returned = [makeRef("anything", "cap")];
    expect(scoreRecall(returned, [])).toBe(1);
  });
});

describe("scorePrecision", () => {
  it("returns 1.0 when every returned chunk is expected", () => {
    const returned = [makeRef("c1", "cap"), makeRef("c2", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId, "c2" as ChunkId];
    expect(scorePrecision(returned, expected)).toBe(1);
  });

  it("returns 0.0 when no returned chunk is expected", () => {
    const returned = [makeRef("x1", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId];
    expect(scorePrecision(returned, expected)).toBe(0);
  });

  it("returns the partial-hit ratio", () => {
    const returned = [makeRef("c1", "cap"), makeRef("x1", "cap")];
    const expected: readonly ChunkId[] = ["c1" as ChunkId];
    expect(scorePrecision(returned, expected)).toBe(0.5);
  });

  it("returns 1.0 vacuously when `returned` is empty", () => {
    expect(scorePrecision([], ["c1" as ChunkId])).toBe(1);
  });
});

describe("scoreSourceIsolation", () => {
  it("returns 1.0 when every returned reference is in scope", () => {
    const returned = [makeRef("c1", "cap-a"), makeRef("c2", "cap-a")];
    expect(scoreSourceIsolation(returned, ["cap-a" as KnowledgeCapsuleId])).toBe(1);
  });

  it("returns 0.0 when even one returned reference is out of scope", () => {
    const returned = [makeRef("c1", "cap-a"), makeRef("c2", "cap-b")];
    expect(scoreSourceIsolation(returned, ["cap-a" as KnowledgeCapsuleId])).toBe(0);
  });

  it("returns 1.0 vacuously when `returned` is empty", () => {
    expect(scoreSourceIsolation([], ["cap-a" as KnowledgeCapsuleId])).toBe(1);
  });

  it("permits any capsule in a multi-capsule scope", () => {
    const returned = [makeRef("c1", "cap-a"), makeRef("c2", "cap-b")];
    expect(
      scoreSourceIsolation(returned, [
        "cap-a" as KnowledgeCapsuleId,
        "cap-b" as KnowledgeCapsuleId,
      ]),
    ).toBe(1);
  });
});

describe("scoreCitationQuality", () => {
  it("returns 1.0 when every page-unit reference has a pageNumber", () => {
    const returned = [
      makeRef("c1", "cap", { pageNumber: 1 }),
      makeRef("c2", "cap", { pageNumber: 2 }),
    ];
    const kinds = new Map<string, CitationRequirementKey>([
      ["c1", "page"],
      ["c2", "page"],
    ]);
    expect(scoreCitationQuality(returned, kinds)).toBe(1);
  });

  it("returns 0.0 when no page-unit reference has a pageNumber", () => {
    const returned = [makeRef("c1", "cap"), makeRef("c2", "cap")];
    const kinds = new Map<string, CitationRequirementKey>([
      ["c1", "page"],
      ["c2", "page"],
    ]);
    expect(scoreCitationQuality(returned, kinds)).toBe(0);
  });

  it("returns 0.5 when half the page-unit references are missing pageNumber", () => {
    const returned = [makeRef("c1", "cap", { pageNumber: 1 }), makeRef("c2", "cap")];
    const kinds = new Map<string, CitationRequirementKey>([
      ["c1", "page"],
      ["c2", "page"],
    ]);
    expect(scoreCitationQuality(returned, kinds)).toBe(0.5);
  });

  it("treats section-unit refs as well-formed iff sectionPath is non-empty", () => {
    const returned = [
      makeRef("c1", "cap", { sectionPath: ["chapter", "1"] }),
      makeRef("c2", "cap", { sectionPath: [] }),
    ];
    const kinds = new Map<string, CitationRequirementKey>([
      ["c1", "section"],
      ["c2", "section"],
    ]);
    expect(scoreCitationQuality(returned, kinds)).toBe(0.5);
  });

  it("treats span-bearing unit refs as well-formed iff characterStart/End are present", () => {
    const returned = [
      makeRef("c1", "cap", { characterStart: 0, characterEnd: 10 }),
      makeRef("c2", "cap", { characterStart: 0 }),
    ];
    const kinds = new Map<string, CitationRequirementKey>([
      ["c1", "json-path"],
      ["c2", "csv-row"],
    ]);
    expect(scoreCitationQuality(returned, kinds)).toBe(0.5);
  });

  it("treats unsupported-media unit refs as vacuously well-formed", () => {
    const returned = [makeRef("c1", "cap")];
    const kinds = new Map<string, CitationRequirementKey>([["c1", "unsupported-media"]]);
    expect(scoreCitationQuality(returned, kinds)).toBe(1);
  });

  it("treats refs without unit-kind metadata as well-formed (no test data is not a citation failure)", () => {
    const returned = [makeRef("c1", "cap")];
    expect(scoreCitationQuality(returned, new Map())).toBe(1);
  });

  it("returns 1.0 vacuously when `references` is empty", () => {
    expect(scoreCitationQuality([], new Map())).toBe(1);
  });
});

describe("scoreNoEvidenceAccuracy", () => {
  it("returns 1 when actual matches expected (true === true)", () => {
    expect(scoreNoEvidenceAccuracy(true, true)).toBe(1);
  });

  it("returns 1 when actual matches expected (false === false)", () => {
    expect(scoreNoEvidenceAccuracy(false, false)).toBe(1);
  });

  it("returns 0 when actual claims no-evidence but expected was something", () => {
    expect(scoreNoEvidenceAccuracy(true, false)).toBe(0);
  });

  it("returns 0 when actual returned refs but expected was no-evidence", () => {
    expect(scoreNoEvidenceAccuracy(false, true)).toBe(0);
  });
});
