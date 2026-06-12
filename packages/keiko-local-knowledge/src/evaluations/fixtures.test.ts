// Structural validation for the eval fixtures (Epic #189, Issue #268). These tests do
// NOT exercise the retrieval runner — they only pin the internal consistency of every
// fixture so a typo in `expectedChunkIds` is caught at unit-test time rather than during
// a runner integration failure that would be harder to diagnose.

import { describe, expect, it } from "vitest";

import {
  ALL_FIXTURES,
  ambiguousQueryFixture,
  broadQueryDiversityFixture,
  contextBudgetFixture,
  multiCapsuleFixture,
  multiPageFixture,
  noEvidenceFixture,
  singleTopicFixture,
  staleIndexFixture,
  structuredFileFixture,
  sourceIsolationFixture,
  wrongScopeFixture,
} from "./fixtures.js";
import type { RetrievalEvalFixture } from "./types.js";

function collectChunkIds(fixture: RetrievalEvalFixture): Set<string> {
  const ids = new Set<string>();
  for (const capsule of fixture.capsules) {
    for (const source of capsule.sources) {
      for (const doc of source.documents) {
        for (const chunk of doc.chunks) ids.add(String(chunk.id));
      }
    }
  }
  return ids;
}

function collectCapsuleIds(fixture: RetrievalEvalFixture): Set<string> {
  return new Set(fixture.capsules.map((c) => String(c.id)));
}

describe("fixtures — registry", () => {
  it("ALL_FIXTURES includes every named fixture exactly once", () => {
    const ids = ALL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      singleTopicFixture.id,
      multiCapsuleFixture.id,
      noEvidenceFixture.id,
      ambiguousQueryFixture.id,
      sourceIsolationFixture.id,
      wrongScopeFixture.id,
      multiPageFixture.id,
      structuredFileFixture.id,
      contextBudgetFixture.id,
      staleIndexFixture.id,
      broadQueryDiversityFixture.id,
    ]);
  });

  it("every fixture has at least one capsule and at least one query", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.capsules.length).toBeGreaterThan(0);
      expect(fixture.queries.length).toBeGreaterThan(0);
    }
  });
});

describe("fixtures — internal consistency", () => {
  it("every expectedChunkId references a chunk defined in the fixture", () => {
    for (const fixture of ALL_FIXTURES) {
      const declared = collectChunkIds(fixture);
      for (const query of fixture.queries) {
        const expected = query.expectedChunkIds ?? [];
        for (const id of expected) {
          expect(declared.has(String(id))).toBe(true);
        }
      }
    }
  });

  it("every query scope references capsules declared in the fixture", () => {
    for (const fixture of ALL_FIXTURES) {
      const declared = collectCapsuleIds(fixture);
      for (const query of fixture.queries) {
        if (query.scope.kind === "capsule") {
          expect(declared.has(String(query.scope.capsuleId))).toBe(true);
        } else {
          for (const id of query.scope.capsuleIds) {
            expect(declared.has(String(id))).toBe(true);
          }
        }
      }
    }
  });

  it("expectedNoEvidence is mutually exclusive with non-empty expectedChunkIds", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const query of fixture.queries) {
        const expectsNoEvidence = query.expectedNoEvidence === true;
        const expectsRefs = (query.expectedChunkIds ?? []).length > 0;
        expect(expectsNoEvidence && expectsRefs).toBe(false);
        // And at least one of the two MUST be set — a query that asserts neither is
        // un-scoreable.
        expect(expectsNoEvidence || expectsRefs).toBe(true);
      }
    }
  });

  it("every document declares at least one chunk and one parsed unit", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const capsule of fixture.capsules) {
        for (const source of capsule.sources) {
          for (const doc of source.documents) {
            expect(doc.chunks.length).toBeGreaterThan(0);
            expect(doc.parsedUnits.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("chunk IDs are unique within each fixture", () => {
    for (const fixture of ALL_FIXTURES) {
      const seen = new Set<string>();
      for (const capsule of fixture.capsules) {
        for (const source of capsule.sources) {
          for (const doc of source.documents) {
            for (const chunk of doc.chunks) {
              const key = String(chunk.id);
              expect(seen.has(key)).toBe(false);
              seen.add(key);
            }
          }
        }
      }
    }
  });

  it("every chunk-level parsedUnitId resolves inside its document", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const capsule of fixture.capsules) {
        for (const source of capsule.sources) {
          for (const doc of source.documents) {
            const ids = new Set(doc.parsedUnits.map((unit) => unit.id));
            for (const chunk of doc.chunks) {
              if (chunk.parsedUnitId === undefined) continue;
              expect(ids.has(chunk.parsedUnitId)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("fixtures — embedding identity is consistent", () => {
  it("all capsules in a capsule-set query share the same embedding identity", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const query of fixture.queries) {
        if (query.scope.kind !== "capsule-set") continue;
        const inScope = fixture.capsules.filter((c) =>
          query.scope.kind === "capsule-set"
            ? query.scope.capsuleIds.some((id) => String(id) === String(c.id))
            : false,
        );
        expect(inScope.length).toBeGreaterThan(0);
        const first = inScope[0];
        if (first === undefined) throw new Error("unreachable");
        for (const capsule of inScope) {
          expect(capsule.embeddingModelIdentity.vectorDimensions).toBe(
            first.embeddingModelIdentity.vectorDimensions,
          );
          expect(capsule.embeddingModelIdentity.vectorMetric).toBe(
            first.embeddingModelIdentity.vectorMetric,
          );
        }
      }
    }
  });
});
