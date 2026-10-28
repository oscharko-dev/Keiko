// Unit tests for the Local Knowledge Connector contracts (Epic #189, Issue #191). Each
// negative test mutates exactly one field of a known-good fixture so failures point
// precisely at the broken invariant — the same mutation-robust pattern used by
// connected-context.test.ts and workflow-handoff.test.ts.

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CAPSULE_CONTEXTUAL_RETRIEVAL_DOCUMENT_CONTEXT_MAX_CHARS_MAX,
  CAPSULE_CONTEXTUAL_RETRIEVAL_MAX_CONTEXT_CHARS_MAX,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CONNECTOR_NODE_KINDS,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
} from "./local-knowledge.js";
import {
  CAPSULE_REINDEX_MODES,
  DOCUMENT_STATUSES,
  INDEXING_JOB_STATUSES,
  PARSED_UNIT_KINDS,
  PARSER_DIAGNOSTIC_SEVERITIES,
} from "./local-knowledge-records.js";
import type {
  CapsuleSet,
  EmbeddingModelIdentity,
  EmbeddingVectorNormalization,
  CapsuleContextualRetrievalSettings,
  ConnectorGraphState,
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorId,
} from "./local-knowledge.js";
import type {
  CapsuleDeleteRequest,
  CapsuleHealth,
  CapsuleReindexRequest,
  ChunkRecord,
  CitationReference,
  DocumentRecord,
  RetrievalReference,
  VectorRecord,
} from "./local-knowledge-records.js";
import {
  type LocalKnowledgeValidation,
  isSafeDisplaySummary,
  validateCapsuleSet,
  validateCapsuleContextualRetrievalSettings,
  validateCapsuleReindexRequest,
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
    expect(CAPSULE_REINDEX_MODES).toEqual([
      "changed-files",
      "repair-failed",
      "resume",
      "full-reembed",
      "full-rebuild",
    ]);
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

  it("rejects a files scope with absolute or out-of-root entries", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "files",
        rootPath: "knowledge",
        files: ["/etc/passwd"],
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeSourceScope({
        kind: "files",
        rootPath: "knowledge",
        files: ["C:\\Users\\victim\\secret.txt"],
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

  it("rejects empty, unsafe, duplicate, and cancelling glob lists", () => {
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        includeGlobs: [],
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        includeGlobs: ["../escape/**"],
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        includeGlobs: ["**/*.md", "**/*.md"],
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeSourceScope({
        kind: "folder",
        rootPath: "knowledge",
        recursive: false,
        includeGlobs: ["**/*.md"],
        excludeGlobs: ["**/*.md"],
      }).ok,
    ).toBe(false);
  });
});

// ─── validateKnowledgeCapsule ─────────────────────────────────────────────────
describe("validateKnowledgeCapsule", () => {
  it("accepts a happy capsule", () => {
    expect(validateKnowledgeCapsule(happyCapsule()).ok).toBe(true);
  });

  it("accepts typed contextual retrieval settings", () => {
    const capsule = {
      ...happyCapsule(),
      contextualRetrieval: {
        enabled: true,
        modelId: "context-chat",
        promptVersion: "contextual-retrieval-v1",
        strict: true,
        maxContextChars: 480,
        documentContextMaxChars: 12_000,
      },
    };
    expect(validateKnowledgeCapsule(capsule).ok).toBe(true);
    expect(validateCapsuleContextualRetrievalSettings(capsule.contextualRetrieval).ok).toBe(true);
  });

  it("rejects empty displayName", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), displayName: "   " }).ok).toBe(false);
  });

  it("rejects browser-unsafe displayName values", () => {
    expect(validateKnowledgeCapsule({ ...happyCapsule(), displayName: "safe\x00danger" }).ok).toBe(
      false,
    );
    expect(validateKnowledgeCapsule({ ...happyCapsule(), displayName: "bell\x07" }).ok).toBe(false);
    expect(
      validateKnowledgeCapsule({
        ...happyCapsule(),
        displayName: "x".repeat(4097),
      }).ok,
    ).toBe(false);
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

  it("rejects unsafe optional metadata keys and values", () => {
    expect(
      validateKnowledgeCapsule({
        ...happyCapsule(),
        metadata: { "unsafe\x07key": "ok" },
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeCapsule({
        ...happyCapsule(),
        metadata: { safe: "x".repeat(1025) },
      }).ok,
    ).toBe(false);
    expect(
      validateKnowledgeCapsule({
        ...happyCapsule(),
        metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, "v"])),
      }).ok,
    ).toBe(false);
  });

  it("rejects invalid contextual retrieval settings", () => {
    expect(validateCapsuleContextualRetrievalSettings({ enabled: "yes" }).ok).toBe(false);
    expect(
      validateKnowledgeCapsule({
        ...happyCapsule(),
        contextualRetrieval: {
          enabled: true,
          modelId: "unsafe\x00model",
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCapsuleContextualRetrievalSettings({
        enabled: true,
        maxContextChars: CAPSULE_CONTEXTUAL_RETRIEVAL_MAX_CONTEXT_CHARS_MAX + 1,
      }).ok,
    ).toBe(false);
    expect(
      validateCapsuleContextualRetrievalSettings({
        enabled: true,
        documentContextMaxChars: CAPSULE_CONTEXTUAL_RETRIEVAL_DOCUMENT_CONTEXT_MAX_CHARS_MAX + 1,
      }).ok,
    ).toBe(false);
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

  it("rejects browser-unsafe display metadata", () => {
    expect(validateCapsuleSet({ ...happyCapsuleSet(), displayName: "bad\x07" }).ok).toBe(false);
    expect(validateCapsuleSet({ ...happyCapsuleSet(), description: "bad\x00" }).ok).toBe(false);
    expect(validateCapsuleSet({ ...happyCapsuleSet(), tags: ["ok", "bad\x1b"] }).ok).toBe(false);
  });
});

// ─── validateCapsuleReindexRequest ────────────────────────────────────────────
describe("validateCapsuleReindexRequest", () => {
  it("accepts a shared reindex request contract", () => {
    expect(
      validateCapsuleReindexRequest({
        capsuleId: "cap-1",
        mode: "changed-files",
        force: true,
      }).ok,
    ).toBe(true);
  });

  it("accepts full-reembed with force=true", () => {
    expect(
      validateCapsuleReindexRequest({
        capsuleId: "cap-1",
        mode: "full-reembed",
        force: true,
      }).ok,
    ).toBe(true);
  });

  it("accepts an exact resume-job precondition only with resume mode", () => {
    expect(
      validateCapsuleReindexRequest({
        capsuleId: "cap-1",
        mode: "resume",
        resumeJobId: "job-abandoned",
      }).ok,
    ).toBe(true);
    expect(
      validateCapsuleReindexRequest({
        capsuleId: "cap-1",
        mode: "changed-files",
        resumeJobId: "job-abandoned",
      }).ok,
    ).toBe(false);
    expect(
      validateCapsuleReindexRequest({
        capsuleId: "cap-1",
        mode: "resume",
        resumeJobId: " ",
      }).ok,
    ).toBe(false);
  });

  it("rejects invalid mode, missing capsule id, and non-boolean force", () => {
    expect(validateCapsuleReindexRequest({ capsuleId: "", mode: "changed-files" }).ok).toBe(false);
    expect(validateCapsuleReindexRequest({ capsuleId: "cap-1", mode: "all-files" }).ok).toBe(false);
    expect(validateCapsuleReindexRequest({ capsuleId: "cap-1", force: "yes" }).ok).toBe(false);
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

  it("rejects malformed node payloads on each node kind", () => {
    expect(
      validateConnectorGraphState({
        ...happyGraph(),
        nodes: [
          {
            kind: "files-window",
            nodeId: "n-1",
            scope: { kind: "folder", rootPath: "unsafe\x00path", recursive: true },
          },
          {
            kind: "local-knowledge",
            nodeId: "n-2",
            target: { kind: "capsule", capsuleId: "" },
          },
          {
            kind: "conversation-center",
            nodeId: "n-3",
            conversationId: "conv-1",
            route: "",
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects cross-kind extra payload fields on graph nodes and targets", () => {
    expect(
      validateConnectorGraphState({
        ...happyGraph(),
        nodes: [
          { kind: "files-window", nodeId: "n-1", scope: happyFolderScope(), target: {} },
          {
            kind: "local-knowledge",
            nodeId: "n-2",
            target: { kind: "capsule", capsuleId: "cap-1" },
          },
          { kind: "conversation-center", nodeId: "n-3", conversationId: "conv-1", route: "/chat" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateConnectorGraphState({
        ...happyGraph(),
        nodes: [
          { kind: "files-window", nodeId: "n-1", scope: happyFolderScope() },
          {
            kind: "local-knowledge",
            nodeId: "n-2",
            target: { kind: "capsule", capsuleId: "cap-1", capsuleSetId: "set-1" },
          },
          { kind: "conversation-center", nodeId: "n-3", conversationId: "conv-1", route: "/chat" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects an edge whose referenced kinds do not match the graph nodes", () => {
    const graph = happyGraph();
    const result = validateConnectorGraphState({
      ...graph,
      edges: [
        {
          from: { nodeId: "n-1", kind: "conversation-center" },
          to: { nodeId: "n-2", kind: "files-window" },
          createdAt: 1,
        },
      ],
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

  it("VectorRecord requires chunkId, capsuleId, sourceId, and documentId", () => {
    // @ts-expect-error — missing chunkId
    const missingChunk: VectorRecord = {
      id: vec("v-1"),
      capsuleId: cap("c-1"),
      sourceId: src("s-1"),
      documentId: doc("d-1"),
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
      sourceId: src("s-1"),
      documentId: doc("d-1"),
      embeddingIdentity: happyEmbeddingIdentity() as VectorRecord["embeddingIdentity"],
      vectorDimensions: 1536,
      storageReference: "row-2",
      createdAt: 0,
    };
    expect(missingCapsule.id).toBe(vec("v-2"));

    // @ts-expect-error — missing sourceId
    const missingSource: VectorRecord = {
      id: vec("v-3"),
      chunkId: chk("ch-2"),
      capsuleId: cap("c-1"),
      documentId: doc("d-1"),
      embeddingIdentity: happyEmbeddingIdentity() as VectorRecord["embeddingIdentity"],
      vectorDimensions: 1536,
      storageReference: "row-3",
      createdAt: 0,
    };
    expect(missingSource.id).toBe(vec("v-3"));

    // @ts-expect-error — missing documentId
    const missingDocument: VectorRecord = {
      id: vec("v-4"),
      chunkId: chk("ch-3"),
      capsuleId: cap("c-1"),
      sourceId: src("s-1"),
      embeddingIdentity: happyEmbeddingIdentity() as VectorRecord["embeddingIdentity"],
      vectorDimensions: 1536,
      storageReference: "row-4",
      createdAt: 0,
    };
    expect(missingDocument.id).toBe(vec("v-4"));
  });

  it("CitationReference requires capsuleId, sourceId, documentId, and chunkId", () => {
    const objectCitation: CitationReference = {
      documentId: doc("d-1"),
      capsuleId: cap("c-1"),
      sourceId: src("s-1"),
      chunkId: chk("ch-1"),
      safeDisplayName: "a.json",
      jsonPointer: "/policy/title",
      tableName: "csv",
      rowIndex: 2,
    };
    expect(objectCitation.jsonPointer).toBe("/policy/title");
    expect(objectCitation.rowIndex).toBe(2);

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

describe("CapsuleReindexRequest", () => {
  it("type-pins the shared reindex request shape", () => {
    const req: CapsuleReindexRequest = {
      capsuleId: cap("c-1"),
      mode: "full-rebuild",
      force: true,
    };
    expect(req.mode).toBe("full-rebuild");
  });
});

describe("CapsuleHealth lineage", () => {
  it("requires sourceIds alongside capsuleId", () => {
    // @ts-expect-error — sourceIds are required so health cannot become capsule-only.
    const missingSources: CapsuleHealth = {
      capsuleId: cap("c-1"),
      lifecycleState: "ready",
      storageSizeBytes: 0,
      documentCount: 0,
      chunkCount: 0,
      vectorCount: 0,
      embeddingIdentity: happyEmbeddingIdentity() as CapsuleHealth["embeddingIdentity"],
      vectorCompatible: true,
      failedDocuments: 0,
      skippedDocuments: 0,
      unsupportedDocuments: 0,
      unsupportedGuidanceCodes: [],
      staleReasons: [],
    };
    expect(missingSources.capsuleId).toBe(cap("c-1"));
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

import {
  validateCapsuleSet as publicValidateSet,
  validateEmbeddingModelIdentity as publicValidateEmbeddingIdentity,
  validateCapsuleContextualRetrievalSettings as publicValidateContextualRetrieval,
  validateCapsuleReindexRequest as publicValidateReindex,
  validateConnectorGraphState as publicValidateGraph,
  type LocalKnowledgeValidation as PublicKnowledgeValidation,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-validation";
import type {
  CapsuleSet as PublicCapsuleSet,
  EmbeddingModelIdentity as PublicEmbeddingModelIdentity,
  CapsuleContextualRetrievalSettings as PublicContextualRetrieval,
  CapsuleReindexRequest as PublicReindexRequest,
  ConnectorGraphState as PublicGraphState,
  KnowledgeCapsuleId as PublicKnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";

export function parsePublicKnowledgeSet(
  input: unknown,
): PublicKnowledgeValidation<PublicCapsuleSet> {
  const result = publicValidateSet(input);
  return result;
}

describe("Knowledge capsule set public responsibility (#3918)", () => {
  it("pins exact unknown inputs checked results and nested declarations", () => {
    expectTypeOf(validateCapsuleSet).parameter(0).toBeUnknown();
    expectTypeOf(publicValidateSet).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicKnowledgeSet).parameter(0).toBeUnknown();
    expectTypeOf(validateCapsuleSet).parameter(0).not.toBeAny();
    expectTypeOf(publicValidateSet).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicKnowledgeSet).parameter(0).not.toBeAny();
    expectTypeOf<
      readonly [
        ReturnType<typeof validateCapsuleSet>,
        ReturnType<typeof publicValidateSet>,
        ReturnType<typeof parsePublicKnowledgeSet>,
      ]
    >().toEqualTypeOf<
      readonly [
        LocalKnowledgeValidation<CapsuleSet>,
        PublicKnowledgeValidation<PublicCapsuleSet>,
        PublicKnowledgeValidation<PublicCapsuleSet>,
      ]
    >();
    expectTypeOf(validateCapsuleSet).returns.not.toBeAny();
    expectTypeOf(publicValidateSet).returns.not.toBeAny();
    expectTypeOf(parsePublicKnowledgeSet).returns.not.toBeAny();
    const result = parsePublicKnowledgeSet(happyCapsuleSet());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<PublicCapsuleSet>();
      expectTypeOf(result.value).not.toBeAny();
      expectTypeOf(result.value).not.toBeUnknown();
      expectTypeOf(result.value.id).not.toBeAny();
      expectTypeOf(result.value.id).not.toBeUnknown();
      expectTypeOf(result.value.capsuleIds).not.toBeAny();
      expectTypeOf(result.value.capsuleIds).not.toBeUnknown();
      expectTypeOf(result.value.tags).not.toBeAny();
      expectTypeOf(result.value.tags).not.toBeUnknown();
      expectTypeOf(result.value.description).not.toBeAny();
      expectTypeOf(result.value.description).not.toBeUnknown();
    }
  });
});

export function parsePublicKnowledgeReindex(
  input: unknown,
): PublicKnowledgeValidation<PublicReindexRequest> {
  const result = publicValidateReindex(input);
  return result;
}

describe("Knowledge reindex public responsibility (#3918)", () => {
  it("pins exact unknown inputs checked results and nested declarations", () => {
    expectTypeOf(validateCapsuleReindexRequest).parameter(0).toBeUnknown();
    expectTypeOf(publicValidateReindex).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicKnowledgeReindex).parameter(0).toBeUnknown();
    expectTypeOf(validateCapsuleReindexRequest).parameter(0).not.toBeAny();
    expectTypeOf(publicValidateReindex).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicKnowledgeReindex).parameter(0).not.toBeAny();
    expectTypeOf<
      readonly [
        ReturnType<typeof validateCapsuleReindexRequest>,
        ReturnType<typeof publicValidateReindex>,
        ReturnType<typeof parsePublicKnowledgeReindex>,
      ]
    >().toEqualTypeOf<
      readonly [
        LocalKnowledgeValidation<CapsuleReindexRequest>,
        PublicKnowledgeValidation<PublicReindexRequest>,
        PublicKnowledgeValidation<PublicReindexRequest>,
      ]
    >();
    expectTypeOf(validateCapsuleReindexRequest).returns.not.toBeAny();
    expectTypeOf(publicValidateReindex).returns.not.toBeAny();
    expectTypeOf(parsePublicKnowledgeReindex).returns.not.toBeAny();
    const result = parsePublicKnowledgeReindex({
      capsuleId: "cap-1",
      mode: "resume",
      force: true,
      resumeJobId: "job-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<PublicReindexRequest>();
      expectTypeOf(result.value).not.toBeAny();
      expectTypeOf(result.value).not.toBeUnknown();
      expectTypeOf(result.value.capsuleId).not.toBeAny();
      expectTypeOf(result.value.capsuleId).not.toBeUnknown();
      expectTypeOf(result.value.mode).not.toBeAny();
      expectTypeOf(result.value.mode).not.toBeUnknown();
      expectTypeOf(result.value.force).not.toBeAny();
      expectTypeOf(result.value.force).not.toBeUnknown();
      expectTypeOf(result.value.resumeJobId).not.toBeAny();
      expectTypeOf(result.value.resumeJobId).not.toBeUnknown();
    }
  });
});

export function parsePublicKnowledgeGraph(
  input: unknown,
): PublicKnowledgeValidation<PublicGraphState> {
  const result = publicValidateGraph(input);
  return result;
}

describe("Knowledge graph public responsibility (#3918)", () => {
  it("pins exact unknown inputs checked results and nested declarations", () => {
    expectTypeOf(validateConnectorGraphState).parameter(0).toBeUnknown();
    expectTypeOf(publicValidateGraph).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicKnowledgeGraph).parameter(0).toBeUnknown();
    expectTypeOf(validateConnectorGraphState).parameter(0).not.toBeAny();
    expectTypeOf(publicValidateGraph).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicKnowledgeGraph).parameter(0).not.toBeAny();
    expectTypeOf<
      readonly [
        ReturnType<typeof validateConnectorGraphState>,
        ReturnType<typeof publicValidateGraph>,
        ReturnType<typeof parsePublicKnowledgeGraph>,
      ]
    >().toEqualTypeOf<
      readonly [
        LocalKnowledgeValidation<ConnectorGraphState>,
        PublicKnowledgeValidation<PublicGraphState>,
        PublicKnowledgeValidation<PublicGraphState>,
      ]
    >();
    expectTypeOf(validateConnectorGraphState).returns.not.toBeAny();
    expectTypeOf(publicValidateGraph).returns.not.toBeAny();
    expectTypeOf(parsePublicKnowledgeGraph).returns.not.toBeAny();
    const result = parsePublicKnowledgeGraph(happyGraph());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<PublicGraphState>();
      expectTypeOf(result.value).not.toBeAny();
      expectTypeOf(result.value).not.toBeUnknown();
      expectTypeOf(result.value.nodes).not.toBeAny();
      expectTypeOf(result.value.nodes).not.toBeUnknown();
      expectTypeOf(result.value.edges).not.toBeAny();
      expectTypeOf(result.value.edges).not.toBeUnknown();
      expectTypeOf(result.value.updatedAt).not.toBeAny();
      expectTypeOf(result.value.updatedAt).not.toBeUnknown();
    }
  });
});

describe("Knowledge capsule set public responsibility (#3918)", () => {
  it("preserves set identity optional presence and nominal capsule lineage", () => {
    for (const state of ["omitted", "undefined", "present"]) {
      const input = happyCapsuleSet();
      if (state !== "omitted") input.description = state === "undefined" ? undefined : "fixture";
      const result = parsePublicKnowledgeSet(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.capsuleIds).toBe(input.capsuleIds);
      expect(result.value.tags).toBe(input.tags);
      expect(Object.hasOwn(result.value, "description")).toBe(state !== "omitted");
      expectTypeOf(result.value.capsuleIds).toEqualTypeOf<PublicCapsuleSet["capsuleIds"]>();
      expectTypeOf(result.value.id).toEqualTypeOf<PublicCapsuleSet["id"]>();
    }
  });
  it("refuses malformed set fields and checks physical collection positions", () => {
    const replaced = Object.defineProperty([0], "every", { value: (): boolean => true });
    for (const input of [
      null,
      [],
      { ...happyCapsuleSet(), id: "" },
      { ...happyCapsuleSet(), displayName: "" },
      { ...happyCapsuleSet(), capsuleIds: [] },
      { ...happyCapsuleSet(), capsuleIds: replaced },
      { ...happyCapsuleSet(), capsuleIds: new Array<unknown>(1) },
      { ...happyCapsuleSet(), composedAt: Number.POSITIVE_INFINITY },
      { ...happyCapsuleSet(), tags: ["bad\u0000tag"] },
    ])
      expect(parsePublicKnowledgeSet(input).ok).toBe(false);
    const inherited = new Array<unknown>(1);
    Object.setPrototypeOf(inherited, ["cap-1"]);
    const input = { ...happyCapsuleSet(), capsuleIds: inherited };
    const result = parsePublicKnowledgeSet(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.capsuleIds).toBe(inherited);
  });
});

describe("Knowledge reindex public responsibility (#3918)", () => {
  it("preserves reindex identity and optional presence without adding defaults", () => {
    for (const state of ["omitted", "undefined", "present"]) {
      const input: Record<string, unknown> = { capsuleId: "cap-1" };
      if (state !== "omitted") {
        input.mode = state === "undefined" ? undefined : "resume";
        input.force = state === "undefined" ? undefined : true;
        input.resumeJobId = state === "undefined" ? undefined : "job-1";
      }
      const result = parsePublicKnowledgeReindex(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      for (const field of ["mode", "force", "resumeJobId"])
        expect(Object.hasOwn(result.value, field)).toBe(state !== "omitted");
      expectTypeOf(result.value.capsuleId).toEqualTypeOf<PublicKnowledgeCapsuleId>();
    }
  });
  it("refuses invalid mode force and resume preconditions", () => {
    for (const input of [
      null,
      {},
      { capsuleId: "", mode: "changed-files" },
      { capsuleId: "cap-1", mode: "all-files" },
      { capsuleId: "cap-1", force: "yes" },
      { capsuleId: "cap-1", mode: "resume", resumeJobId: " " },
      { capsuleId: "cap-1", mode: "changed-files", resumeJobId: "job-1" },
    ])
      expect(parsePublicKnowledgeReindex(input).ok).toBe(false);
  });
});

describe("Knowledge graph public responsibility (#3918)", () => {
  it("preserves graph node edge target identities and nominal lineage", () => {
    const input = happyGraph();
    const result = parsePublicKnowledgeGraph(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.value.nodes).toBe(input.nodes);
    expect(result.value.edges).toBe(input.edges);
    for (const node of result.value.nodes) {
      expectTypeOf(node).not.toBeAny();
      if (node.kind === "local-knowledge" && node.target.kind === "capsule") {
        expectTypeOf(node.target.capsuleId).toEqualTypeOf<PublicKnowledgeCapsuleId>();
        expect(node.target.capsuleId).toBe("cap-1");
      }
    }
  });
  it("refuses invalid graph references discriminants and nested target fields", () => {
    for (const input of [
      null,
      { ...happyGraph(), schemaVersion: "unsupported" },
      { ...happyGraph(), nodes: [{ kind: "unknown", nodeId: "n-1" }] },
      {
        ...happyGraph(),
        nodes: [
          { kind: "local-knowledge", nodeId: "n-1", target: { kind: "capsule", capsuleId: 1 } },
        ],
      },
      {
        ...happyGraph(),
        edges: [
          {
            from: { nodeId: "missing", kind: "files-window" },
            to: { nodeId: "n-2", kind: "local-knowledge" },
            createdAt: 1,
          },
        ],
      },
      { ...happyGraph(), updatedAt: Number.NaN },
    ])
      expect(parsePublicKnowledgeGraph(input).ok).toBe(false);
  });
});

describe("Knowledge graph public responsibility (#3918)", () => {
  it("revalidates actual endpoint reads before admitting graph edges", () => {
    for (const replacement of [undefined, null, 1]) {
      let reads = 0;
      const endpoint = { nodeId: "n-1", kind: "files-window" };
      const edge = {
        get from(): unknown {
          reads += 1;
          return reads === 1 ? endpoint : replacement;
        },
        to: { nodeId: "n-2", kind: "local-knowledge" },
        createdAt: 1,
      };
      expect(parsePublicKnowledgeGraph({ ...happyGraph(), edges: [edge] })).toEqual({
        ok: false,
        errors: ["graph.edges entry must have from/to objects"],
      });
      expect(reads).toBe(2);
    }
  });
});

function assertSetPresentUndefinedTypes(): void {
  expectTypeOf<Required<CapsuleSet>["description"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<Required<PublicCapsuleSet>["description"]>().toEqualTypeOf<string | undefined>();
}

it("preserves source and public Set option presence with truthful types", (): void => {
  assertSetPresentUndefinedTypes();
  for (const validate of [validateCapsuleSet, publicValidateSet]) {
    const input = { ...happyCapsuleSet(), description: undefined };
    const result = validate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("Expected admitted own-undefined options");
    expect(result.value).toBe(input);
    for (const field of ["description"] as const) {
      expect(Object.hasOwn(result.value, field)).toBe(true);
      expect(result.value[field]).toBeUndefined();
    }
    if ("description" in result.value) {
      expectTypeOf(result.value.description).toEqualTypeOf<string | undefined>();
    }
  }
});

function assertReindexPresentUndefinedTypes(): void {
  expectTypeOf<Required<CapsuleReindexRequest>["mode"]>().toEqualTypeOf<
    (typeof CAPSULE_REINDEX_MODES)[number] | undefined
  >();
  expectTypeOf<Required<PublicReindexRequest>["mode"]>().toEqualTypeOf<
    (typeof CAPSULE_REINDEX_MODES)[number] | undefined
  >();
  expectTypeOf<Required<CapsuleReindexRequest>["force"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<Required<PublicReindexRequest>["force"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<Required<CapsuleReindexRequest>["resumeJobId"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicReindexRequest>["resumeJobId"]>().toEqualTypeOf<string | undefined>();
}

it("preserves source and public Reindex option presence with truthful types", (): void => {
  assertReindexPresentUndefinedTypes();
  for (const validate of [validateCapsuleReindexRequest, publicValidateReindex]) {
    const input = { capsuleId: "cap-1", mode: undefined, force: undefined, resumeJobId: undefined };
    const result = validate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("Expected admitted own-undefined options");
    expect(result.value).toBe(input);
    for (const field of ["mode", "force", "resumeJobId"] as const) {
      expect(Object.hasOwn(result.value, field)).toBe(true);
      expect(result.value[field]).toBeUndefined();
    }
    if ("mode" in result.value) {
      expectTypeOf(result.value.mode).toEqualTypeOf<
        (typeof CAPSULE_REINDEX_MODES)[number] | undefined
      >();
    }
    if ("force" in result.value) {
      expectTypeOf(result.value.force).toEqualTypeOf<boolean | undefined>();
    }
    if ("resumeJobId" in result.value) {
      expectTypeOf(result.value.resumeJobId).toEqualTypeOf<string | undefined>();
    }
  }
});

function assertEmbeddingIdentityPresentUndefinedTypes(): void {
  expectTypeOf<Required<EmbeddingModelIdentity>["modelRevision"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicEmbeddingModelIdentity>["modelRevision"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<EmbeddingModelIdentity>["normalization"]>().toEqualTypeOf<
    EmbeddingVectorNormalization | undefined
  >();
  expectTypeOf<Required<PublicEmbeddingModelIdentity>["normalization"]>().toEqualTypeOf<
    EmbeddingVectorNormalization | undefined
  >();
  expectTypeOf<Required<EmbeddingModelIdentity>["instructionVersion"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicEmbeddingModelIdentity>["instructionVersion"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<EmbeddingModelIdentity>["embeddingSpaceFingerprint"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicEmbeddingModelIdentity>["embeddingSpaceFingerprint"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<EmbeddingModelIdentity>["dimensionsParam"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<Required<PublicEmbeddingModelIdentity>["dimensionsParam"]>().toEqualTypeOf<
    number | undefined
  >();
}

it("preserves source and public EmbeddingIdentity option presence with truthful types", (): void => {
  assertEmbeddingIdentityPresentUndefinedTypes();
  const fixture = validateEmbeddingModelIdentity(happyEmbeddingIdentity());
  if (!fixture.ok) throw new TypeError("Expected healthy embedding fixture");
  for (const validate of [validateEmbeddingModelIdentity, publicValidateEmbeddingIdentity]) {
    const input = {
      ...fixture.value,
      modelRevision: undefined,
      normalization: undefined,
      instructionVersion: undefined,
      embeddingSpaceFingerprint: undefined,
      dimensionsParam: undefined,
    };
    const result = validate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("Expected admitted own-undefined options");
    expect(result.value).toBe(input);
    for (const field of [
      "modelRevision",
      "normalization",
      "instructionVersion",
      "embeddingSpaceFingerprint",
      "dimensionsParam",
    ] as const) {
      expect(Object.hasOwn(result.value, field)).toBe(true);
      expect(result.value[field]).toBeUndefined();
    }
    if ("modelRevision" in result.value) {
      expectTypeOf(result.value.modelRevision).toEqualTypeOf<string | undefined>();
    }
    if ("normalization" in result.value) {
      expectTypeOf(result.value.normalization).toEqualTypeOf<
        EmbeddingVectorNormalization | undefined
      >();
    }
    if ("instructionVersion" in result.value) {
      expectTypeOf(result.value.instructionVersion).toEqualTypeOf<string | undefined>();
    }
    if ("embeddingSpaceFingerprint" in result.value) {
      expectTypeOf(result.value.embeddingSpaceFingerprint).toEqualTypeOf<string | undefined>();
    }
    if ("dimensionsParam" in result.value) {
      expectTypeOf(result.value.dimensionsParam).toEqualTypeOf<number | undefined>();
    }
  }
});

function assertContextualRetrievalPresentUndefinedTypes(): void {
  expectTypeOf<Required<CapsuleContextualRetrievalSettings>["modelId"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicContextualRetrieval>["modelId"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<CapsuleContextualRetrievalSettings>["promptVersion"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<PublicContextualRetrieval>["promptVersion"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<CapsuleContextualRetrievalSettings>["strict"]>().toEqualTypeOf<
    boolean | undefined
  >();
  expectTypeOf<Required<PublicContextualRetrieval>["strict"]>().toEqualTypeOf<
    boolean | undefined
  >();
  expectTypeOf<Required<CapsuleContextualRetrievalSettings>["maxContextChars"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<Required<PublicContextualRetrieval>["maxContextChars"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<
    Required<CapsuleContextualRetrievalSettings>["documentContextMaxChars"]
  >().toEqualTypeOf<number | undefined>();
  expectTypeOf<Required<PublicContextualRetrieval>["documentContextMaxChars"]>().toEqualTypeOf<
    number | undefined
  >();
}

it("preserves source and public ContextualRetrieval option presence with truthful types", (): void => {
  assertContextualRetrievalPresentUndefinedTypes();
  for (const validate of [
    validateCapsuleContextualRetrievalSettings,
    publicValidateContextualRetrieval,
  ]) {
    const input = {
      enabled: true,
      modelId: undefined,
      promptVersion: undefined,
      strict: undefined,
      maxContextChars: undefined,
      documentContextMaxChars: undefined,
    };
    const result = validate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("Expected admitted own-undefined options");
    expect(result.value).toBe(input);
    for (const field of [
      "modelId",
      "promptVersion",
      "strict",
      "maxContextChars",
      "documentContextMaxChars",
    ] as const) {
      expect(Object.hasOwn(result.value, field)).toBe(true);
      expect(result.value[field]).toBeUndefined();
    }
    if ("modelId" in result.value) {
      expectTypeOf(result.value.modelId).toEqualTypeOf<string | undefined>();
    }
    if ("promptVersion" in result.value) {
      expectTypeOf(result.value.promptVersion).toEqualTypeOf<string | undefined>();
    }
    if ("strict" in result.value) {
      expectTypeOf(result.value.strict).toEqualTypeOf<boolean | undefined>();
    }
    if ("maxContextChars" in result.value) {
      expectTypeOf(result.value.maxContextChars).toEqualTypeOf<number | undefined>();
    }
    if ("documentContextMaxChars" in result.value) {
      expectTypeOf(result.value.documentContextMaxChars).toEqualTypeOf<number | undefined>();
    }
  }
});
