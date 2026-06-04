// Unit tests for the Local Knowledge Connector contracts (Epic #189, Issue #191). Each
// negative test mutates exactly one field of a known-good fixture so failures point
// precisely at the broken invariant — the same mutation-robust pattern used by
// connected-context.test.ts and workflow-handoff.test.ts.

import { describe, it, expect } from "vitest";
import {
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CONNECTOR_NODE_KINDS,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
} from "./local-knowledge.js";
import {
  DOCUMENT_STATUSES,
  INDEXING_JOB_STATUSES,
  PARSED_UNIT_KINDS,
  PARSER_DIAGNOSTIC_SEVERITIES,
} from "./local-knowledge-records.js";
import type {
  CapsuleSet,
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorId,
} from "./local-knowledge.js";
import type {
  CapsuleDeleteRequest,
  ChunkRecord,
  CitationReference,
  DocumentRecord,
  RetrievalReference,
  VectorRecord,
} from "./local-knowledge-records.js";
import {
  isSafeDisplaySummary,
  validateCapsuleSet,
  validateConnectorGraphState,
  validateEmbeddingModelIdentity,
  validateKnowledgeCapsule,
  validateKnowledgeSourceScope,
} from "./local-knowledge-validation.js";
import { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";

// ─── Branded-ID helpers ───────────────────────────────────────────────────────
// Construct branded IDs at test boundaries; production code must do the same through its
// own minting helper (the contracts package deliberately does not provide one).
const cap = (s: string): KnowledgeCapsuleId => s as KnowledgeCapsuleId;
const src = (s: string): KnowledgeSourceId => s as KnowledgeSourceId;
const doc = (s: string): DocumentId => s as DocumentId;
const chk = (s: string): ChunkId => s as ChunkId;
const vec = (s: string): VectorId => s as VectorId;

// ─── Fixtures ─────────────────────────────────────────────────────────────────
function happyEmbeddingIdentity(): unknown {
  return {
    provider: "openai",
    modelId: "text-embedding-3-small",
    vectorDimensions: 1536,
    vectorMetric: "cosine",
  };
}

function happyCapsule(): Record<string, unknown> {
  return {
    id: "cap-1",
    displayName: "Risk Controls Library",
    tags: ["compliance"],
    sourceIds: ["src-1"],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: happyEmbeddingIdentity(),
    lifecycleState: "ready",
    storageReference: "capsules/cap-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
  };
}

function happyCapsuleSet(): Record<string, unknown> {
  return {
    id: "set-1",
    displayName: "Quarterly Review",
    tags: [],
    capsuleIds: ["cap-1", "cap-2"],
    composedAt: 1_700_000_000_000,
  };
}

function happyFolderScope(): Record<string, unknown> {
  return {
    kind: "folder",
    rootPath: "knowledge/2026-q2",
    recursive: true,
  };
}

function happyGraph(): Record<string, unknown> {
  return {
    schemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
    nodes: [
      { kind: "files-window", nodeId: "n-1", scope: happyFolderScope() },
      {
        kind: "local-knowledge",
        nodeId: "n-2",
        target: { kind: "capsule", capsuleId: "cap-1" },
      },
      {
        kind: "conversation-center",
        nodeId: "n-3",
        conversationId: "conv-1",
        route: "/chat/conv-1",
      },
    ],
    edges: [
      {
        from: { nodeId: "n-1", kind: "files-window" },
        to: { nodeId: "n-2", kind: "local-knowledge" },
        createdAt: 1,
      },
      {
        from: { nodeId: "n-2", kind: "local-knowledge" },
        to: { nodeId: "n-3", kind: "conversation-center" },
        createdAt: 2,
      },
    ],
    updatedAt: 1_700_000_000_000,
  };
}

// ─── LOCAL_KNOWLEDGE_SCHEMA_VERSION ───────────────────────────────────────────
describe("LOCAL_KNOWLEDGE_SCHEMA_VERSION", () => {
  it("is the literal string '1'", () => {
    expect(LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe("1");
  });
});

// ─── Frozen-constant arrays ───────────────────────────────────────────────────
describe("frozen-constant arrays", () => {
  it("CAPSULE_LIFECYCLE_STATES enumerates all six states", () => {
    expect(CAPSULE_LIFECYCLE_STATES).toEqual([
      "draft",
      "indexing",
      "ready",
      "stale",
      "deleting",
      "error",
    ]);
  });

  it("CAPSULE_RETRIEVAL_EFFORTS has the three legal efforts", () => {
    expect(CAPSULE_RETRIEVAL_EFFORTS).toEqual(["minimal", "default", "deep"]);
  });

  it("CAPSULE_OUTPUT_MODES has the three legal modes", () => {
    expect(CAPSULE_OUTPUT_MODES).toEqual(["answers", "snippets", "raw"]);
  });

  it("CAPSULE_ANSWER_GROUNDING_POLICIES has the three legal policies", () => {
    expect(CAPSULE_ANSWER_GROUNDING_POLICIES).toEqual([
      "require-citations",
      "require-citations-or-state-no-evidence",
      "best-effort",
    ]);
  });

  it("EMBEDDING_VECTOR_METRICS includes cosine, euclidean, and dot", () => {
    expect(EMBEDDING_VECTOR_METRICS).toEqual(["cosine", "euclidean", "dot"]);
  });

  it("KNOWLEDGE_SOURCE_SCOPE_KINDS includes folder, repository, files", () => {
    expect(KNOWLEDGE_SOURCE_SCOPE_KINDS).toEqual(["folder", "repository", "files"]);
  });

  it("CONNECTOR_NODE_KINDS covers files-window, local-knowledge, conversation-center", () => {
    expect(CONNECTOR_NODE_KINDS).toEqual([
      "files-window",
      "local-knowledge",
      "conversation-center",
    ]);
  });

  it("DOCUMENT_STATUSES, PARSED_UNIT_KINDS, INDEXING_JOB_STATUSES, PARSER_DIAGNOSTIC_SEVERITIES are non-empty", () => {
    expect(DOCUMENT_STATUSES.length).toBeGreaterThan(0);
    expect(PARSED_UNIT_KINDS.length).toBeGreaterThan(0);
    expect(INDEXING_JOB_STATUSES.length).toBeGreaterThan(0);
    expect(PARSER_DIAGNOSTIC_SEVERITIES).toEqual(["info", "warning", "error"]);
  });
});

// ─── isSafeDisplaySummary ─────────────────────────────────────────────────────
describe("isSafeDisplaySummary", () => {
  it("accepts a normal display string", () => {
    expect(isSafeDisplaySummary("Risk Controls Library")).toBe(true);
  });

  it("accepts a string with newlines and tabs", () => {
    expect(isSafeDisplaySummary("line one\nline two\twith tab")).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(isSafeDisplaySummary(undefined)).toBe(false);
    expect(isSafeDisplaySummary(null)).toBe(false);
    expect(isSafeDisplaySummary(42)).toBe(false);
    expect(isSafeDisplaySummary({})).toBe(false);
  });

  it("rejects strings longer than 4096 characters", () => {
    expect(isSafeDisplaySummary("x".repeat(4096))).toBe(true);
    expect(isSafeDisplaySummary("x".repeat(4097))).toBe(false);
  });

  it("rejects NUL bytes", () => {
    expect(isSafeDisplaySummary("safe\x00danger")).toBe(false);
  });

  it("rejects DEL (\\x7F) and other ASCII control bytes", () => {
    expect(isSafeDisplaySummary("danger\x7f")).toBe(false);
    expect(isSafeDisplaySummary("bell\x07")).toBe(false);
    expect(isSafeDisplaySummary("vertical-tab\x0b")).toBe(false);
    expect(isSafeDisplaySummary("form-feed\x0c")).toBe(false);
    expect(isSafeDisplaySummary("escape\x1b")).toBe(false);
  });
});

// ─── isSafeScopePath ──────────────────────────────────────────────────────────
describe("isSafeScopePath", () => {
  it("accepts a workspace-relative folder path", () => {
    expect(isSafeScopePath("knowledge/2026-q2")).toBe(true);
  });

  it("accepts an explicit absolute POSIX path that is not a root marker", () => {
    expect(isSafeScopePath("/Users/owner/docs/library")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isSafeScopePath("")).toBe(false);
  });

  it("rejects literal root markers / and \\ and ~ and .", () => {
    for (const marker of ["/", "\\", "~", "."]) {
      expect(isSafeScopePath(marker)).toBe(false);
    }
  });

  it("rejects tilde-prefixed paths (shell home expansion)", () => {
    expect(isSafeScopePath("~/secrets")).toBe(false);
    expect(isSafeScopePath("~root/etc")).toBe(false);
  });

  it("rejects NUL bytes", () => {
    expect(isSafeScopePath("danger\x00here")).toBe(false);
  });

  it("rejects traversal segments anywhere in the path", () => {
    expect(isSafeScopePath("..")).toBe(false);
    expect(isSafeScopePath("../parent")).toBe(false);
    expect(isSafeScopePath("knowledge/../etc/passwd")).toBe(false);
    expect(isSafeScopePath("a/b/..")).toBe(false);
  });

  it("rejects Windows-style drive letters and UNC prefixes", () => {
    expect(isSafeScopePath("C:")).toBe(false);
    expect(isSafeScopePath("C:\\")).toBe(false);
    expect(isSafeScopePath("\\\\server\\share")).toBe(false);
  });
});

// ─── isSafeStorageReference ───────────────────────────────────────────────────
describe("isSafeStorageReference", () => {
  it("accepts a relative path under the runtime-state root", () => {
    expect(isSafeStorageReference("capsules/cap-1")).toBe(true);
    expect(isSafeStorageReference("cap-1.sqlite")).toBe(true);
  });

  it("rejects empty, NUL, traversal, tilde, absolute, and drive-letter forms", () => {
    expect(isSafeStorageReference("")).toBe(false);
    expect(isSafeStorageReference("danger\x00here")).toBe(false);
    expect(isSafeStorageReference("../outside")).toBe(false);
    expect(isSafeStorageReference("capsules/../etc/passwd")).toBe(false);
    expect(isSafeStorageReference("/etc/passwd")).toBe(false);
    expect(isSafeStorageReference("\\etc\\passwd")).toBe(false);
    expect(isSafeStorageReference("~/secrets")).toBe(false);
    expect(isSafeStorageReference("C:\\Users\\victim")).toBe(false);
  });
});

// ─── validateEmbeddingModelIdentity ───────────────────────────────────────────
describe("validateEmbeddingModelIdentity", () => {
  it("accepts a happy identity", () => {
    const result = validateEmbeddingModelIdentity(happyEmbeddingIdentity());
    expect(result.ok).toBe(true);
  });

  it("accepts an identity with an optional modelRevision", () => {
    const input = { ...(happyEmbeddingIdentity() as object), modelRevision: "rev-2026-05" };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(validateEmbeddingModelIdentity(null).ok).toBe(false);
    expect(validateEmbeddingModelIdentity("hi").ok).toBe(false);
    expect(validateEmbeddingModelIdentity([]).ok).toBe(false);
  });

  it("rejects empty provider", () => {
    const input = { ...(happyEmbeddingIdentity() as object), provider: "" };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects empty modelId", () => {
    const input = { ...(happyEmbeddingIdentity() as object), modelId: "   " };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects zero vectorDimensions", () => {
    const input = { ...(happyEmbeddingIdentity() as object), vectorDimensions: 0 };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects negative vectorDimensions", () => {
    const input = { ...(happyEmbeddingIdentity() as object), vectorDimensions: -1 };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects Infinity and NaN vectorDimensions", () => {
    expect(
      validateEmbeddingModelIdentity({
        ...(happyEmbeddingIdentity() as object),
        vectorDimensions: Number.POSITIVE_INFINITY,
      }).ok,
    ).toBe(false);
    expect(
      validateEmbeddingModelIdentity({
        ...(happyEmbeddingIdentity() as object),
        vectorDimensions: Number.NaN,
      }).ok,
    ).toBe(false);
  });

  it("rejects non-integer vectorDimensions (the >0 → >=0 mutation would survive without this)", () => {
    const input = { ...(happyEmbeddingIdentity() as object), vectorDimensions: 1.5 };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown vectorMetric", () => {
    const input = { ...(happyEmbeddingIdentity() as object), vectorMetric: "minkowski" };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects empty modelRevision when provided", () => {
    const input = { ...(happyEmbeddingIdentity() as object), modelRevision: "" };
    const result = validateEmbeddingModelIdentity(input);
    expect(result.ok).toBe(false);
  });
});

// ─── validateKnowledgeSourceScope ─────────────────────────────────────────────
describe("validateKnowledgeSourceScope", () => {
  it("accepts a folder scope", () => {
    expect(validateKnowledgeSourceScope(happyFolderScope()).ok).toBe(true);
  });

  it("accepts a repository scope", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "repository",
        repositoryRoot: "repos/main",
      }).ok,
    ).toBe(true);
  });

  it("accepts a files scope with at least one entry", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "files",
        rootPath: "knowledge",
        files: ["a.md", "b.md"],
      }).ok,
    ).toBe(true);
  });

  it("rejects non-objects and arrays", () => {
    expect(validateKnowledgeSourceScope(null).ok).toBe(false);
    expect(validateKnowledgeSourceScope([]).ok).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(validateKnowledgeSourceScope({ kind: "url", rootPath: "ok" }).ok).toBe(false);
  });

  it("rejects a folder scope with an unsafe rootPath", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "../outside",
        recursive: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects a folder scope rooted at literal /", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "/",
        recursive: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects a folder scope rooted at ~", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "~",
        recursive: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects a folder scope with non-boolean recursive", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: "yes",
      }).ok,
    ).toBe(false);
  });

  it("rejects a files scope with empty files array", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "files",
        rootPath: "knowledge",
        files: [],
      }).ok,
    ).toBe(false);
  });

  it("rejects a files scope where any entry is unsafe", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "files",
        rootPath: "knowledge",
        files: ["a.md", "../b.md"],
      }).ok,
    ).toBe(false);
  });

  it("rejects globs with NUL bytes or empty strings", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        includeGlobs: ["*.md", ""],
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        excludeGlobs: ["danger\x00here"],
      }).ok,
    ).toBe(false);
  });
});

// ─── validateKnowledgeCapsule ─────────────────────────────────────────────────
describe("validateKnowledgeCapsule", () => {
  it("accepts a happy capsule", () => {
    expect(validateKnowledgeCapsule(happyCapsule()).ok).toBe(true);
  });

  it("rejects empty displayName", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), displayName: "   " }).ok).toBe(false);
  });

  it("rejects negative createdAt and updatedAt", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), createdAt: -1 }).ok).toBe(false);
    expect(validateKnowledgeCapsule({ ...happyCapsule(), updatedAt: -1 }).ok).toBe(false);
  });

  it("rejects unsafe storageReference", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), storageReference: "../escape" }).ok).toBe(
      false,
    );
    expect(
      validateKnowledgeCapsule({ ...happyCapsule(), storageReference: "/etc/passwd" }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeCapsule({ ...happyCapsule(), storageReference: "danger\x00here" }).ok,
    ).toBe(false);
  });

  it("rejects zero-source capsules", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), sourceIds: [] }).ok).toBe(false);
  });

  it("rejects missing embedding identity", () => {
    const input = { ...happyCapsule() };
    delete (input as { embeddingModelIdentity?: unknown }).embeddingModelIdentity;
    expect(validateKnowledgeCapsule(input).ok).toBe(false);
  });

  it("rejects zero vectorDimensions through nested identity check", () => {
    const input = {
      ...happyCapsule(),
      embeddingModelIdentity: { ...(happyEmbeddingIdentity() as object), vectorDimensions: 0 },
    };
    expect(validateKnowledgeCapsule(input).ok).toBe(false);
  });

  it("rejects unsupported retrievalEffort", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), retrievalEffort: "exhaustive" }).ok).toBe(
      false,
    );
  });

  it("rejects unsupported outputMode", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), outputMode: "html" }).ok).toBe(false);
  });

  it("rejects unsupported answerGroundingPolicy", () => {
    expect(
      validateKnowledgeCapsule({ ...happyCapsule(), answerGroundingPolicy: "trust-the-model" }).ok,
    ).toBe(false);
  });

  it("rejects unsupported lifecycleState", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), lifecycleState: "archived" }).ok).toBe(
      false,
    );
  });
});

// ─── validateCapsuleSet ───────────────────────────────────────────────────────
describe("validateCapsuleSet", () => {
  it("accepts a happy set", () => {
    expect(validateCapsuleSet(happyCapsuleSet()).ok).toBe(true);
  });

  it("rejects empty capsuleIds", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), capsuleIds: [] }).ok).toBe(false);
  });

  it("rejects non-array capsuleIds", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), capsuleIds: "cap-1" }).ok).toBe(false);
  });

  it("rejects empty string entries in capsuleIds", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), capsuleIds: ["cap-1", ""] }).ok).toBe(false);
  });

  it("rejects non-finite composedAt", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), composedAt: Number.NaN }).ok).toBe(false);
    expect(validateCapsuleSet({ ...happyCapsuleSet(), composedAt: -1 }).ok).toBe(false);
  });

  it("rejects empty id or displayName", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), id: "" }).ok).toBe(false);
    expect(validateCapsuleSet({ ...happyCapsuleSet(), displayName: "   " }).ok).toBe(false);
  });
});

// ─── validateConnectorGraphState ──────────────────────────────────────────────
describe("validateConnectorGraphState", () => {
  it("accepts a happy graph", () => {
    expect(validateConnectorGraphState(happyGraph()).ok).toBe(true);
  });

  it("rejects an edge whose from.nodeId is unknown", () => {
    const graph = happyGraph();
    const result = validateConnectorGraphState({
      ...graph,
      edges: [
        {
          from: { nodeId: "missing", kind: "files-window" },
          to: { nodeId: "n-2", kind: "local-knowledge" },
          createdAt: 1,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an edge whose to.nodeId is unknown", () => {
    const graph = happyGraph();
    const result = validateConnectorGraphState({
      ...graph,
      edges: [
        {
          from: { nodeId: "n-1", kind: "files-window" },
          to: { nodeId: "ghost", kind: "conversation-center" },
          createdAt: 1,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate node IDs", () => {
    const result = validateConnectorGraphState({
      schemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      nodes: [
        { kind: "files-window", nodeId: "dup", scope: happyFolderScope() },
        { kind: "files-window", nodeId: "dup", scope: happyFolderScope() },
      ],
      edges: [],
      updatedAt: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown node kinds", () => {
    const result = validateConnectorGraphState({
      schemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      nodes: [{ kind: "ghost-node", nodeId: "n", scope: happyFolderScope() }],
      edges: [],
      updatedAt: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a graph whose schemaVersion is not '1'", () => {
    expect(validateConnectorGraphState({ ...happyGraph(), schemaVersion: "2" }).ok).toBe(false);
  });

  it("rejects a graph whose updatedAt is negative", () => {
    expect(validateConnectorGraphState({ ...happyGraph(), updatedAt: -1 }).ok).toBe(false);
  });
});

// ─── Foundry IQ lineage invariants (type-level) ───────────────────────────────
// These tests rely on `// @ts-expect-error` to fail compilation if any of the lineage
// requirements is dropped. If a future refactor weakens DocumentRecord, ChunkRecord,
// VectorRecord, CitationReference, or RetrievalReference, the @ts-expect-error becomes
// a "code unused" error and this test stops compiling.
describe("Foundry IQ lineage invariants", () => {
  it("DocumentRecord requires capsuleId, sourceId, and id", () => {
    // @ts-expect-error — missing capsuleId
    const missingCapsule: DocumentRecord = {
      id: doc("d-1"),
      sourceId: src("s-1"),
      documentPath: "a.md",
      sizeBytes: 1,
      mediaType: "text/markdown",
      contentHash: "abc",
      parser: { parserId: "p", parserVersion: "1" },
      lastExtractedAt: 0,
      status: "extracted",
      safeDisplayName: "a.md",
    };
    expect(missingCapsule.id).toBe(doc("d-1"));

    // @ts-expect-error — missing sourceId
    const missingSource: DocumentRecord = {
      id: doc("d-2"),
      capsuleId: cap("c-1"),
      documentPath: "a.md",
      sizeBytes: 1,
      mediaType: "text/markdown",
      contentHash: "abc",
      parser: { parserId: "p", parserVersion: "1" },
      lastExtractedAt: 0,
      status: "extracted",
      safeDisplayName: "a.md",
    };
    expect(missingSource.id).toBe(doc("d-2"));
  });

  it("ChunkRecord requires capsuleId, sourceId, and documentId", () => {
    // @ts-expect-error — missing documentId
    const missingDoc: ChunkRecord = {
      id: chk("ch-1"),
      capsuleId: cap("c-1"),
      sourceId: src("s-1"),
      parsedUnit: { kind: "unsupported-media", documentId: doc("d"), reason: "n/a" },
      orderIndex: 0,
      tokenCount: 1,
      safeExcerptHash: "abc",
    };
    expect(missingDoc.id).toBe(chk("ch-1"));
  });

  it("VectorRecord requires chunkId and capsuleId", () => {
    // @ts-expect-error — missing chunkId
    const missingChunk: VectorRecord = {
      id: vec("v-1"),
      capsuleId: cap("c-1"),
      embeddingIdentity: happyEmbeddingIdentity() as VectorRecord["embeddingIdentity"],
      vectorDimensions: 1536,
      storageReference: "row-1",
      createdAt: 0,
    };
    expect(missingChunk.id).toBe(vec("v-1"));

    // @ts-expect-error — missing capsuleId
    const missingCapsule: VectorRecord = {
      id: vec("v-2"),
      chunkId: chk("ch-1"),
      embeddingIdentity: happyEmbeddingIdentity() as VectorRecord["embeddingIdentity"],
      vectorDimensions: 1536,
      storageReference: "row-2",
      createdAt: 0,
    };
    expect(missingCapsule.id).toBe(vec("v-2"));
  });

  it("CitationReference requires capsuleId, sourceId, documentId, and chunkId", () => {
    // @ts-expect-error — missing chunkId
    const missingChunk: CitationReference = {
      documentId: doc("d-1"),
      capsuleId: cap("c-1"),
      sourceId: src("s-1"),
      safeDisplayName: "a.md",
    };
    expect(missingChunk.documentId).toBe(doc("d-1"));
  });

  it("RetrievalReference requires capsuleId and a well-formed citation", () => {
    // @ts-expect-error — missing capsuleId
    const missingCapsule: RetrievalReference = {
      chunkId: chk("ch-1"),
      score: 0.5,
      citation: {
        documentId: doc("d-1"),
        capsuleId: cap("c-1"),
        sourceId: src("s-1"),
        chunkId: chk("ch-1"),
        safeDisplayName: "a.md",
      },
    };
    expect(missingCapsule.chunkId).toBe(chk("ch-1"));
  });
});

// ─── CapsuleSet purity ────────────────────────────────────────────────────────
describe("CapsuleSet purity", () => {
  it("type cannot carry vector, chunk, document, or source fields", () => {
    const withVectors: CapsuleSet = {
      id: "set-1" as unknown as CapsuleSet["id"],
      displayName: "ok",
      tags: [],
      capsuleIds: [cap("c-1")],
      composedAt: 0,
      // @ts-expect-error — vectorIds is not a property of CapsuleSet; sets reference capsule IDs only.
      vectorIds: ["v-1"],
    };
    expect(withVectors.id).toBeDefined();

    const withChunks: CapsuleSet = {
      id: "set-2" as unknown as CapsuleSet["id"],
      displayName: "ok",
      tags: [],
      capsuleIds: [cap("c-1")],
      composedAt: 0,
      // @ts-expect-error — chunks is not a property of CapsuleSet; Foundry IQ composition is logical only.
      chunks: [],
    };
    expect(withChunks.id).toBeDefined();
  });
});

// ─── CapsuleDeleteRequest.deleteSources is the literal false ─────────────────
describe("CapsuleDeleteRequest", () => {
  it("accepts deleteSources: false", () => {
    const req: CapsuleDeleteRequest = {
      capsuleId: cap("c-1"),
      deleteIndex: true,
      deleteSources: false,
    };
    expect(req.deleteSources).toBe(false);
  });

  it("type-rejects deleteSources: true", () => {
    const req: CapsuleDeleteRequest = {
      capsuleId: cap("c-1"),
      deleteIndex: true,
      // @ts-expect-error — deleteSources is pinned to the literal false; sources are user files outside Keiko.
      deleteSources: true,
    };
    expect(req.deleteSources).toBeDefined();
  });
});

// ─── Mutation-robustness anchors ──────────────────────────────────────────────
// Each anchor names a single-line mutation the validators must catch. If any of the
// listed mutations slip through the implementation, exactly one of these assertions
// fails, naming the broken invariant.
describe("mutation-robustness anchors", () => {
  it("vectorDimensions >0 → >=0 mutation: zero must reject", () => {
    expect(
      validateEmbeddingModelIdentity({
        ...(happyEmbeddingIdentity() as object),
        vectorDimensions: 0,
      }).ok,
    ).toBe(false);
  });

  it("path-empty check: empty string must reject as storage reference", () => {
    expect(isSafeStorageReference("")).toBe(false);
  });

  it("traversal check: '..' anywhere must reject", () => {
    expect(isSafeScopePath("a/../b")).toBe(false);
  });

  it("graph duplicate-detection check: same nodeId twice must reject", () => {
    const result = validateConnectorGraphState({
      schemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      nodes: [
        { kind: "files-window", nodeId: "x", scope: happyFolderScope() },
        {
          kind: "local-knowledge",
          nodeId: "x",
          target: { kind: "capsule", capsuleId: "cap-1" },
        },
      ],
      edges: [],
      updatedAt: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("capsuleSet non-empty check: empty array must reject", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), capsuleIds: [] }).ok).toBe(false);
  });
});
