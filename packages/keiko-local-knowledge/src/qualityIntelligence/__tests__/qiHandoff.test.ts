// Tests for the QI handoff adapter (Epic #270, Issue #278).
//
// Verifies that `buildCapsuleSourceEnvelopes` converts `RetrievalReference` lists
// into `QualityIntelligenceLocalKnowledgeCapsuleEnvelope`s with the correct shape,
// and rejects invalid inputs with typed `QiHandoffError`s.

import { describe, expect, it } from "vitest";
import type {
  ChunkId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  DocumentId,
  CitationReference,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import { buildCapsuleSourceEnvelopes, QiHandoffError } from "../qiHandoff.js";

// ─── synthetic fixture helpers ────────────────────────────────────────────────

const TS = "2026-06-05T00:00:00Z";
const ZERO_HASH = "0".repeat(64);

/** Cast a plain string to the ChunkId brand without a constructor (test-only). */
const asChunk = (id: string): ChunkId => id as ChunkId;
const asCapsule = (id: string): KnowledgeCapsuleId => id as KnowledgeCapsuleId;
const asSource = (id: string): KnowledgeSourceId => id as KnowledgeSourceId;
const asDoc = (id: string): DocumentId => id as DocumentId;

function ref(
  chunkId: string,
  capsuleId = "capsule-1",
  safeDisplayName = `doc-${chunkId}`,
): RetrievalReference {
  const citation: CitationReference = {
    documentId: asDoc("doc-1"),
    capsuleId: asCapsule(capsuleId),
    sourceId: asSource("src-1"),
    chunkId: asChunk(chunkId),
    safeDisplayName,
  };
  return {
    chunkId: asChunk(chunkId),
    capsuleId: asCapsule(capsuleId),
    score: 0.9,
    citation,
  };
}

// ─── happy path ───────────────────────────────────────────────────────────────

describe("buildCapsuleSourceEnvelopes — happy path", () => {
  it("converts a single RetrievalReference into a local-knowledge-capsule envelope", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("chunk-alpha")],
      integrityHashByChunkId: { "chunk-alpha": ZERO_HASH },
      idPrefix: "qi-lk",
    });

    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope?.kind).toBe("local-knowledge-capsule");
    expect(envelope?.localRef).toBe("chunk-alpha");
    expect(envelope?.provenance.registeredAt).toBe(TS);
    expect(envelope?.provenance.integrityHashSha256Hex).toBe(ZERO_HASH);
    expect(envelope?.provenance.origin).toContain("local-knowledge-capsule:");
    expect(envelope?.displayLabel).toContain("local-knowledge:");
    expect(envelope?.displayLabel).toContain("chunk-alpha");
  });

  it("produces an envelope whose id starts with the caller-supplied idPrefix", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("chunk-beta")],
      integrityHashByChunkId: { "chunk-beta": ZERO_HASH },
      idPrefix: "qi-prefix",
    });
    expect(envelopes[0]?.id).toContain("qi-prefix");
    expect(envelopes[0]?.id).toContain("chunk-beta");
  });

  it("produces one envelope per reference when all chunkIds are distinct", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("c1"), ref("c2"), ref("c3")],
      integrityHashByChunkId: {
        c1: ZERO_HASH,
        c2: ZERO_HASH,
        c3: ZERO_HASH,
      },
      idPrefix: "qi-multi",
    });
    expect(envelopes).toHaveLength(3);
    const kinds: readonly string[] = envelopes.map((e) => e.kind);
    expect(kinds.every((k) => k === "local-knowledge-capsule")).toBe(true);
  });

  it("embeds capsuleId in the provenance origin", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("chunk-c", "my-capsule-id")],
      integrityHashByChunkId: { "chunk-c": ZERO_HASH },
      idPrefix: "qi-origin",
    });
    expect(envelopes[0]?.provenance.origin).toContain("my-capsule-id");
  });

  it("clamps displayLabel to 256 chars when citation name is extremely long", () => {
    const longName = "n".repeat(300);
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("chunk-d", "capsule-1", longName)],
      integrityHashByChunkId: { "chunk-d": ZERO_HASH },
      idPrefix: "qi-clamp",
    });
    expect(envelopes[0]?.displayLabel.length).toBeLessThanOrEqual(256);
  });
});

// ─── typed errors ─────────────────────────────────────────────────────────────

describe("buildCapsuleSourceEnvelopes — typed errors", () => {
  it("throws EMPTY_REFERENCE for an empty references array", () => {
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: TS,
        references: [],
        integrityHashByChunkId: { "chunk-x": ZERO_HASH },
        idPrefix: "qi-empty",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("EMPTY_REFERENCE");
      }
    }
  });

  it("throws EMPTY_HASH_TABLE when integrityHashByChunkId is empty", () => {
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: TS,
        references: [ref("chunk-x")],
        integrityHashByChunkId: {},
        idPrefix: "qi-empty-hash",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("EMPTY_HASH_TABLE");
      }
    }
  });

  it("throws INVALID_REGISTERED_AT for a non-ISO-8601 timestamp", () => {
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: "not-a-date",
        references: [ref("chunk-y")],
        integrityHashByChunkId: { "chunk-y": ZERO_HASH },
        idPrefix: "qi-bad-ts",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("INVALID_REGISTERED_AT");
      }
    }
  });

  it("throws MISSING_INTEGRITY_HASH when a chunkId has no entry in the hash table", () => {
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: TS,
        references: [ref("chunk-z")],
        integrityHashByChunkId: { "other-chunk": ZERO_HASH },
        idPrefix: "qi-missing-hash",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("MISSING_INTEGRITY_HASH");
      }
    }
  });

  it("throws INVALID_INTEGRITY_HASH when a hash is not 64 lowercase hex chars", () => {
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: TS,
        references: [ref("chunk-w")],
        integrityHashByChunkId: { "chunk-w": "bad-hash" },
        idPrefix: "qi-bad-hash",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("INVALID_INTEGRITY_HASH");
      }
    }
  });

  it("throws INVALID_INTEGRITY_HASH for an uppercase hex string (not lowercase)", () => {
    const upperHash = "A".repeat(64);
    try {
      buildCapsuleSourceEnvelopes({
        registeredAt: TS,
        references: [ref("chunk-upper")],
        integrityHashByChunkId: { "chunk-upper": upperHash },
        idPrefix: "qi-upper-hash",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiHandoffError);
      if (err instanceof QiHandoffError) {
        expect(err.code).toBe("INVALID_INTEGRITY_HASH");
      }
    }
  });
});

// ─── shape invariants ─────────────────────────────────────────────────────────

describe("buildCapsuleSourceEnvelopes — shape invariants", () => {
  it("localRef is the raw chunkId (opaque LK identifier, never a URL or path)", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("opaque-chunk-id-42")],
      integrityHashByChunkId: { "opaque-chunk-id-42": ZERO_HASH },
      idPrefix: "qi-shape",
    });
    const envelope = envelopes[0];
    expect(envelope?.localRef).toBe("opaque-chunk-id-42");
    // The localRef should never look like a URL or filesystem path.
    expect(envelope?.localRef).not.toMatch(/^https?:\/\//u);
  });

  it("every envelope has kind 'local-knowledge-capsule'", () => {
    const envelopes = buildCapsuleSourceEnvelopes({
      registeredAt: TS,
      references: [ref("kind-check-1"), ref("kind-check-2")],
      integrityHashByChunkId: {
        "kind-check-1": ZERO_HASH,
        "kind-check-2": ZERO_HASH,
      },
      idPrefix: "qi-kind",
    });
    for (const e of envelopes) {
      expect(e.kind).toBe("local-knowledge-capsule");
    }
  });
});
