import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";

import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import {
  handleAuthorizePdfCitationPreview,
  handleGetPdfCitationPreviewStatus,
} from "./local-knowledge-preview-handlers.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import {
  buildStoredPreviewCitations,
  normalizePreviewMarkerIndex,
} from "./local-knowledge-preview-authority.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

let tmp: string;
let store: UiStore;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-preview-"));
  store = createInMemoryUiStore();
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    uiDbPath: join(tmp, "keiko-ui.db"),
  };
}

function request(body: Record<string, unknown>): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
}

function ctx(path: string, body: Record<string, unknown>): RouteContext {
  return {
    req: request(body),
    res: {} as never,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function auditKinds(capsuleId: KnowledgeCapsuleId): readonly string[] {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    const rows = knowledgeStore._internal.db
      .prepare(
        "SELECT kind FROM capsule_audit_events WHERE capsule_id = :capsuleId ORDER BY occurred_at ASC, rowid ASC",
      )
      .all({ capsuleId: String(capsuleId) }) as unknown as readonly { readonly kind: string }[];
    return rows.map((row) => row.kind);
  } finally {
    knowledgeStore.close();
  }
}

function makeReference(
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  chunkId: ChunkId,
  safeDisplayName: string,
): RetrievalReference {
  return {
    chunkId,
    capsuleId,
    score: 0.91,
    citation: {
      documentId,
      capsuleId,
      sourceId,
      chunkId,
      safeDisplayName,
    },
  };
}

function localKnowledgeAnswer(
  chatId: string,
  assistantMessageId: string,
  citation: LocalKnowledgeEvidenceCitation,
): Extract<GroundedAnswer, { readonly groundingKind: "local-knowledge" }> {
  return {
    groundingKind: "local-knowledge",
    userMessageId: `user-${chatId}`,
    assistantMessageId,
    content: "Grounded answer.",
    citations: [citation],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 10,
    noEvidence: false,
    contextPack: {
      kind: "local-knowledge",
      scopeKind: "capsule",
      scopeId: "lk-preview",
      scopeLabel: "Preview Capsule",
      capsuleCount: 1,
      sourceCount: 1,
      citationCount: 1,
      referenceBudget: 16,
      referencesUsed: 1,
    },
  };
}

async function seedPreviewFixture(): Promise<{
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly previewCitation: StoredPdfCitationPreviewCitation;
}> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName: "Preview Capsule",
    capsuleId: "cap-preview",
    sourceId: "src-preview",
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore._internal.db
    .prepare(
      "UPDATE documents SET media_type = 'application/pdf', content_hash = 'hash-preview', safe_display_name = 'policy.pdf', status = 'extracted' WHERE capsule_id = :capsuleId AND id = :documentId",
    )
    .run({ capsuleId: String(seeded.capsuleId), documentId: String(seeded.documentId) });
  const reference = makeReference(
    seeded.capsuleId,
    seeded.sourceId,
    seeded.documentId,
    must(seeded.chunkIds[0]),
    "policy.pdf",
  );
  const previewCitations = buildStoredPreviewCitations(knowledgeStore, [
    {
      marker: "[1]",
      sourceLabel: "Preview Capsule / Source src-preview",
      reference,
    },
  ]);
  knowledgeStore.close();

  const project = store.createProject(tmp, "preview-project");
  const chat = store.createChat(project.path, "Preview", "chat-model");
  const assistant = store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "Grounded answer.",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const citation = {
    stableId: "answer-citation-1",
    marker: "[1]",
    label: "policy.pdf",
    score: 0.91,
    lineage: {
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      chunkId: must(seeded.chunkIds[0]),
    },
    source: "Preview Capsule / Source src-preview",
  } satisfies LocalKnowledgeEvidenceCitation;
  store.attachGroundedAnswer(
    assistant.id,
    localKnowledgeAnswer(chat.id, assistant.id, citation),
    previewCitations,
  );

  return {
    chatId: chat.id,
    assistantMessageId: assistant.id,
    capsuleId: seeded.capsuleId,
    previewCitation: must(previewCitations[0]),
  };
}

function insertDuplicatePreviewChunk(
  knowledgeStore: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
): RetrievalReference {
  const duplicateParsedUnitId = "unit-preview-duplicate";
  const duplicateChunkId = "chunk-preview-duplicate" as ChunkId;
  knowledgeStore._internal.db
    .prepare(
      "INSERT INTO parsed_units (id, capsule_id, document_id, kind, section_path_json, character_start, character_end) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      duplicateParsedUnitId,
      String(capsuleId),
      String(documentId),
      "section",
      '["Chapter 2"]',
      0,
      100,
    );
  const chunkColumns = knowledgeStore._internal.db.prepare("PRAGMA table_info('chunks')").all() as {
    readonly name?: string;
  }[];
  const hasStrategyVersion = chunkColumns.some(
    (column) => column.name === "chunking_strategy_version",
  );
  if (hasStrategyVersion) {
    knowledgeStore._internal.db
      .prepare(
        "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash, chunking_strategy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        duplicateChunkId,
        String(capsuleId),
        String(sourceId),
        String(documentId),
        duplicateParsedUnitId,
        1,
        256,
        "duplicate-hash",
        "issue-195-v1",
      );
  } else {
    knowledgeStore._internal.db
      .prepare(
        "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        duplicateChunkId,
        String(capsuleId),
        String(sourceId),
        String(documentId),
        duplicateParsedUnitId,
        1,
        256,
        "duplicate-hash",
      );
  }
  return makeReference(capsuleId, sourceId, documentId, duplicateChunkId, "policy.pdf");
}

async function seedDuplicatePreviewFixture(): Promise<{
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly previewCitations: readonly StoredPdfCitationPreviewCitation[];
}> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName: "Preview Capsule",
    capsuleId: "cap-preview",
    sourceId: "src-preview",
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore._internal.db
    .prepare(
      "UPDATE documents SET media_type = 'application/pdf', content_hash = 'hash-preview', safe_display_name = 'policy.pdf', status = 'extracted' WHERE capsule_id = :capsuleId AND id = :documentId",
    )
    .run({ capsuleId: String(seeded.capsuleId), documentId: String(seeded.documentId) });
  const references = [
    makeReference(
      seeded.capsuleId,
      seeded.sourceId,
      seeded.documentId,
      must(seeded.chunkIds[0]),
      "policy.pdf",
    ),
    insertDuplicatePreviewChunk(
      knowledgeStore,
      seeded.capsuleId,
      seeded.sourceId,
      seeded.documentId,
    ),
  ];
  const previewCitations = buildStoredPreviewCitations(knowledgeStore, [
    {
      marker: "[1]",
      sourceLabel: "Preview Capsule / Source src-preview",
      reference: must(references[0]),
    },
    {
      marker: "[1]",
      sourceLabel: "Preview Capsule / Source src-preview",
      reference: must(references[1]),
    },
  ]);
  knowledgeStore.close();

  const project = store.createProject(tmp, "preview-project-duplicate");
  const chat = store.createChat(project.path, "Preview", "chat-model");
  const assistant = store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "Grounded answer.",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const citation = {
    stableId: "answer-citation-1",
    marker: "[1]",
    label: "policy.pdf",
    score: 0.91,
    lineage: {
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      chunkId: must(seeded.chunkIds[0]),
    },
    source: "Preview Capsule / Source src-preview",
  } satisfies LocalKnowledgeEvidenceCitation;
  store.attachGroundedAnswer(
    assistant.id,
    localKnowledgeAnswer(chat.id, assistant.id, citation),
    previewCitations,
  );

  return {
    chatId: chat.id,
    assistantMessageId: assistant.id,
    capsuleId: seeded.capsuleId,
    previewCitations,
  };
}

describe("local-knowledge preview handlers", () => {
  it("normalizes supported preview marker bracket variants", () => {
    expect(normalizePreviewMarkerIndex("[1]")).toBe(1);
    expect(normalizePreviewMarkerIndex("1")).toBe(1);
    expect(normalizePreviewMarkerIndex("［1］")).toBe(1);
    expect(normalizePreviewMarkerIndex("【1】")).toBe(1);
  });

  it("returns available status for a persisted PDF citation without emitting audit rows", async () => {
    const fixture = await seedPreviewFixture();

    const result = await handleGetPdfCitationPreviewStatus(
      ctx("/api/local-knowledge/citation-preview/status", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      matchedCitationCount: 1,
      display: { documentLabel: "policy.pdf", pageNumber: 7, anchorQuality: "approximate" },
    });
    expect(result.body).not.toHaveProperty("authority");
    expect(auditKinds(fixture.capsuleId)).toEqual([]);
  });

  it("authorizes a persisted PDF citation and records an authorization audit event", async () => {
    const fixture = await seedPreviewFixture();

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "authorized",
      display: { documentLabel: "policy.pdf", pageNumber: 7, anchorQuality: "approximate" },
    });
    expect(result.body).not.toHaveProperty("authority");
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-authorized"]);
  });

  it("rejects a stable-id mismatch and records a blocked audit event", async () => {
    const fixture = await seedPreviewFixture();

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: "wrong-stable-id",
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "blocked",
      reason: "stable-id-mismatch",
    });
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-blocked"]);
  });

  it("preserves duplicate markers as distinct stored citations and rejects ambiguous authorization", async () => {
    const fixture = await seedDuplicatePreviewFixture();

    expect(fixture.previewCitations).toHaveLength(2);
    expect(fixture.previewCitations.map((citation) => citation.markerIndex)).toEqual([1, 1]);

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "blocked",
      reason: "citation-not-found",
    });
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-blocked"]);
  });

  it("returns recoverable when the document content hash drifts and records a recoverable audit event", async () => {
    const fixture = await seedPreviewFixture();
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    knowledgeStore._internal.db
      .prepare("UPDATE documents SET content_hash = 'hash-drifted' WHERE capsule_id = :capsuleId")
      .run({ capsuleId: String(fixture.capsuleId) });
    knowledgeStore.close();

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "document-content-mismatch",
    });
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-recoverable"]);
  });

  it("blocks non-PDF preview attempts and records a blocked audit event", async () => {
    const fixture = await seedPreviewFixture();
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    knowledgeStore._internal.db
      .prepare("UPDATE documents SET media_type = 'text/plain' WHERE capsule_id = :capsuleId")
      .run({ capsuleId: String(fixture.capsuleId) });
    knowledgeStore.close();

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "blocked",
      reason: "document-not-pdf",
    });
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-blocked"]);
  });

  it("rejects an invalid marker body with 400 BAD_REQUEST", async () => {
    const fixture = await seedPreviewFixture();

    const result = await handleAuthorizePdfCitationPreview(
      ctx("/api/local-knowledge/citation-preview/authorize", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "zero",
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});
