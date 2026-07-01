import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
import type {
  GroundedAnswer,
  LocalKnowledgeEvidenceCitation,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
  writePdfDocumentBlob,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import { STREAMING } from "./routes.js";
import {
  handleClosePdfCitationPreviewSession,
  handleGetPdfCitationPreviewDocument,
  handleOpenPdfCitationPreviewSession,
} from "./local-knowledge-preview-handlers.js";
import {
  MAX_PDF_PREVIEW_BYTES,
  MAX_PDF_PREVIEW_RANGE_BYTES,
} from "./local-knowledge-preview-delivery.js";
import {
  createPdfCitationPreviewSessionManager,
  type PdfCitationPreviewSessionManager,
} from "./local-knowledge-preview-session-manager.js";
import {
  buildStoredPreviewCitations,
  normalizePreviewMarkerIndex,
} from "./local-knowledge-preview-authority.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>\nendobj\ntrailer<<>>\n%%EOF\n", "utf8");

let tmp: string;
let store: UiStore;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-preview-session-"));
  store = createInMemoryUiStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(
  sessionManager: PdfCitationPreviewSessionManager = createPdfCitationPreviewSessionManager(),
  uiStore: UiStore = store,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    pdfCitationPreviewSessions: sessionManager,
    store: uiStore,
    uiDbPath: join(tmp, "keiko-ui.db"),
  };
}

function request(body: Record<string, unknown>, headers?: Record<string, string>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage & {
    headers: Record<string, string>;
  };
  req.headers = headers ?? {};
  return req;
}

function emptyRequest(headers?: Record<string, string>): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage & { headers: Record<string, string> };
  req.headers = headers ?? {};
  return req;
}

function ctx(
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): RouteContext {
  return {
    req: request(body, headers),
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

async function seedPreviewFixture(options?: {
  readonly bytes?: Buffer;
  readonly mediaType?: string;
  readonly contentHash?: string;
  readonly documentSizeBytes?: number;
}): Promise<{
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly previewCitation: StoredPdfCitationPreviewCitation;
  readonly pdfPath: string;
}> {
  const fileBytes = options?.bytes ?? PDF_BYTES;
  const contentHash = options?.contentHash ?? sha256Hex(fileBytes);
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName: "Preview Capsule",
    capsuleId: "cap-preview",
    sourceId: "src-preview",
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  const sourceRoot = join(tmp, "connected-source");
  const relativePath = "docs/policy.pdf";
  const pdfPath = join(sourceRoot, relativePath);
  mkdirSync(join(sourceRoot, "docs"), { recursive: true });
  writeFileSync(pdfPath, fileBytes);
  const scopeJson = JSON.stringify({ rootPath: sourceRoot, recursive: true });
  knowledgeStore._internal.db
    .prepare("UPDATE knowledge_sources SET scope_json = :scopeJson WHERE id = :sourceId")
    .run({ scopeJson, sourceId: String(seeded.sourceId) });
  knowledgeStore._internal.db
    .prepare(
      "UPDATE capsule_sources SET scope_json = :scopeJson WHERE capsule_id = :capsuleId AND id = :sourceId",
    )
    .run({
      scopeJson,
      capsuleId: String(seeded.capsuleId),
      sourceId: String(seeded.sourceId),
    });
  knowledgeStore._internal.db
    .prepare(
      "UPDATE documents SET document_path = :documentPath, media_type = :mediaType, content_hash = :contentHash, safe_display_name = 'policy.pdf', status = 'extracted', size_bytes = :sizeBytes WHERE capsule_id = :capsuleId AND id = :documentId",
    )
    .run({
      documentPath: relativePath,
      mediaType: options?.mediaType ?? "application/pdf",
      contentHash,
      sizeBytes: options?.documentSizeBytes ?? fileBytes.byteLength,
      capsuleId: String(seeded.capsuleId),
      documentId: String(seeded.documentId),
    });
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
    pdfPath,
  };
}

function captureResponse(): {
  readonly res: ServerResponse;
  readonly headers: Map<string, string>;
  readonly body: () => Promise<Buffer>;
  readonly statusCode: () => number;
} {
  const stream = new PassThrough({ highWaterMark: MAX_PDF_PREVIEW_RANGE_BYTES + 1024 });
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let ended = false;
  let statusCode = 200;
  const endStream = stream.end.bind(stream);
  stream.on("data", (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  });
  stream.on("end", () => {
    ended = true;
  });
  const res = stream as unknown as ServerResponse;
  const mutableRes = res as ServerResponse & { statusCode: number };
  mutableRes.statusCode = statusCode;
  mutableRes.setHeader = (name, value): ServerResponse => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return res;
  };
  mutableRes.writeHead = (code, values): ServerResponse => {
    statusCode = code;
    mutableRes.statusCode = code;
    for (const [name, value] of Object.entries(values ?? {})) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    }
    return res;
  };
  mutableRes.end = ((chunk?: string | Uint8Array): ServerResponse => {
    if (chunk !== undefined) {
      endStream(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } else {
      endStream();
    }
    return res;
  }) as ServerResponse["end"];
  return {
    res: mutableRes,
    headers,
    body: async (): Promise<Buffer> => {
      if (!ended) {
        await new Promise<void>((resolve) => stream.on("end", resolve));
      }
      return Buffer.concat(chunks);
    },
    statusCode: (): number => statusCode,
  };
}

async function openPreviewSessionHandle(
  fixture: Awaited<ReturnType<typeof seedPreviewFixture>>,
  sessionManager: PdfCitationPreviewSessionManager,
): Promise<string> {
  const opened = await handleOpenPdfCitationPreviewSession(
    ctx("/api/local-knowledge/citation-preview/open", {
      chatId: fixture.chatId,
      assistantMessageId: fixture.assistantMessageId,
      marker: "[1]",
      stableId: fixture.previewCitation.stableId,
    }),
    deps(sessionManager),
  );
  return (opened.body as { readonly session: { readonly handle: string } }).session.handle;
}

function writePreviewFixtureBlob(
  fixture: Awaited<ReturnType<typeof seedPreviewFixture>>,
  bytes: Uint8Array = PDF_BYTES,
): void {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    const written = writePdfDocumentBlob(knowledgeStore, {
      capsuleId: fixture.previewCitation.lineage.capsuleId,
      sourceId: fixture.previewCitation.lineage.sourceId,
      documentId: fixture.previewCitation.lineage.documentId,
      contentHash: fixture.previewCitation.documentContentHash,
      byteLength: bytes.byteLength,
      mediaType: "application/pdf",
      bytes,
    });
    expect(written.kind).toBe("stored");
  } finally {
    knowledgeStore.close();
  }
}

function updatePreviewFixtureSourceRoot(
  fixture: Awaited<ReturnType<typeof seedPreviewFixture>>,
  sourceRoot: string,
): void {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    const scopeJson = JSON.stringify({ rootPath: sourceRoot, recursive: true });
    knowledgeStore._internal.db
      .prepare("UPDATE knowledge_sources SET scope_json = :scopeJson WHERE id = :sourceId")
      .run({
        scopeJson,
        sourceId: String(fixture.previewCitation.lineage.sourceId),
      });
    knowledgeStore._internal.db
      .prepare(
        "UPDATE capsule_sources SET scope_json = :scopeJson WHERE capsule_id = :capsuleId AND id = :sourceId",
      )
      .run({
        scopeJson,
        capsuleId: String(fixture.previewCitation.lineage.capsuleId),
        sourceId: String(fixture.previewCitation.lineage.sourceId),
      });
  } finally {
    knowledgeStore.close();
  }
}

function updatePreviewFixtureDocument(
  fixture: Awaited<ReturnType<typeof seedPreviewFixture>>,
  patch: {
    readonly blobRef?: string | null;
    readonly contentHash?: string;
    readonly documentPath?: string;
    readonly sizeBytes?: number;
    readonly status?: string;
  },
): void {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    if (patch.documentPath !== undefined) {
      knowledgeStore._internal.db
        .prepare("UPDATE documents SET document_path = :documentPath WHERE capsule_id = :capsuleId")
        .run({
          documentPath: patch.documentPath,
          capsuleId: String(fixture.previewCitation.lineage.capsuleId),
        });
    }
    if (patch.contentHash !== undefined || patch.sizeBytes !== undefined || "blobRef" in patch) {
      knowledgeStore._internal.db
        .prepare(
          [
            "UPDATE documents SET",
            "  content_hash = COALESCE(:contentHash, content_hash),",
            "  size_bytes = COALESCE(:sizeBytes, size_bytes),",
            "  blob_ref = :blobRef",
            "WHERE capsule_id = :capsuleId",
          ].join(" "),
        )
        .run({
          contentHash: patch.contentHash ?? null,
          sizeBytes: patch.sizeBytes ?? null,
          blobRef: patch.blobRef ?? null,
          capsuleId: String(fixture.previewCitation.lineage.capsuleId),
        });
    }
    if (patch.status !== undefined) {
      knowledgeStore._internal.db
        .prepare("UPDATE documents SET status = :status WHERE capsule_id = :capsuleId")
        .run({
          status: patch.status,
          capsuleId: String(fixture.previewCitation.lineage.capsuleId),
        });
    }
  } finally {
    knowledgeStore.close();
  }
}

function blobRefForFixture(
  fixture: Awaited<ReturnType<typeof seedPreviewFixture>>,
): string | null | undefined {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    const row = knowledgeStore._internal.db
      .prepare("SELECT blob_ref FROM documents WHERE capsule_id = ? AND id = ?")
      .get(
        String(fixture.previewCitation.lineage.capsuleId),
        String(fixture.previewCitation.lineage.documentId),
      ) as { readonly blob_ref: string | null } | undefined;
    return row?.blob_ref;
  } finally {
    knowledgeStore.close();
  }
}

function disableLazyPdfBlobBackfill(): void {
  vi.spyOn(nodeWorkspaceFs, "readFileBytes").mockRejectedValue(
    new Error("disabled lazy PDF blob backfill"),
  );
}

function documentContext(handle: string, req: IncomingMessage, res: ServerResponse): RouteContext {
  return {
    req,
    res,
    params: { sessionHandle: handle },
    url: new URL(
      `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
    ),
  };
}

describe("local-knowledge preview session handlers", () => {
  it("normalizes supported preview marker bracket variants", () => {
    expect(normalizePreviewMarkerIndex("[1]")).toBe(1);
    expect(normalizePreviewMarkerIndex("1")).toBe(1);
    expect(normalizePreviewMarkerIndex("［1］")).toBe(1);
    expect(normalizePreviewMarkerIndex("【1】")).toBe(1);
    expect(normalizePreviewMarkerIndex("[1】")).toBeUndefined();
    expect(normalizePreviewMarkerIndex("【1]")).toBeUndefined();
  });

  it("opens a preview session from the server-side authorization path and returns an opaque handle", async () => {
    const fixture = await seedPreviewFixture();

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
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
      session: {
        contentType: "application/pdf",
        byteLength: PDF_BYTES.byteLength,
        reused: false,
      },
    });
    expect((result.body as Record<string, unknown>).session).toHaveProperty("handle");
    expect((result.body as Record<string, unknown>).session).toHaveProperty("expiresAt");
    expect((result.body as Record<string, unknown>).authority).toBeUndefined();
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-authorized"]);
  });

  it("serves the cited historical blob after the current document hash drifts", async () => {
    const fixture = await seedPreviewFixture();
    writePreviewFixtureBlob(fixture);
    const changedBytes = Buffer.from("%PDF-1.4\nchanged after answer\n%%EOF\n", "utf8");
    updatePreviewFixtureDocument(fixture, {
      blobRef: null,
      contentHash: sha256Hex(changedBytes),
      sizeBytes: changedBytes.byteLength,
    });
    unlinkSync(fixture.pdfPath);
    const sessionManager = createPdfCitationPreviewSessionManager();

    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      outcome: "authorized",
      session: { byteLength: PDF_BYTES.byteLength },
    });
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    const response = captureResponse();
    const streamed = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), response.res),
      deps(sessionManager),
    );
    expect(streamed).toBe(STREAMING);
    expect(response.statusCode()).toBe(200);
    expect(Buffer.from(await response.body()).equals(PDF_BYTES)).toBe(true);
  });

  it("re-runs authorization and safely reuses the live document session on duplicate open", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();

    const first = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const second = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    const firstSession = (first.body as { readonly session: { readonly handle: string } }).session;
    const secondSession = (
      second.body as {
        readonly session: { readonly handle: string; readonly reused: boolean };
      }
    ).session;
    expect(firstSession.handle).toBe(secondSession.handle);
    expect(secondSession.reused).toBe(true);
    expect(auditKinds(fixture.capsuleId)).toEqual([
      "citation-preview-authorized",
      "citation-preview-authorized",
    ]);
  });

  it("reuses the active session without rehashing verified bytes on duplicate open", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const readRangeSpy = vi.spyOn(nodeWorkspaceFs, "readFileRange");

    const first = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    expect(first.status).toBe(200);
    expect(readRangeSpy).toHaveBeenCalled();

    readRangeSpy.mockClear();
    const second = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    expect((second.body as { readonly session: { readonly reused: boolean } }).session.reused).toBe(
      true,
    );
    expect(readRangeSpy).not.toHaveBeenCalled();
  });

  it("resolves a moved document through the active source binding", async () => {
    const fixture = await seedPreviewFixture();
    const movedRoot = join(tmp, "moved-source");
    renameSync(join(tmp, "connected-source"), movedRoot);
    updatePreviewFixtureSourceRoot(fixture, movedRoot);
    const sessionManager = createPdfCitationPreviewSessionManager();

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    expect(result.body).toMatchObject({
      outcome: "authorized",
      session: { byteLength: PDF_BYTES.byteLength },
    });
  });

  it("resolves case drift under the active source root without relaxing containment", async () => {
    const fixture = await seedPreviewFixture();
    renameSync(fixture.pdfPath, join(tmp, "connected-source", "docs", "Policy.PDF"));
    renameSync(join(tmp, "connected-source", "docs"), join(tmp, "connected-source", "Docs"));
    const sessionManager = createPdfCitationPreviewSessionManager();

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    expect(result.body).toMatchObject({
      outcome: "authorized",
      session: { byteLength: PDF_BYTES.byteLength },
    });
  });

  it("allows legitimate hardlinked files after realpath containment and hash verification", async () => {
    const fixture = await seedPreviewFixture();
    linkSync(fixture.pdfPath, join(tmp, "connected-source", "docs", "policy-hardlink.pdf"));
    const sessionManager = createPdfCitationPreviewSessionManager();

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );

    expect(result.body).toMatchObject({
      outcome: "authorized",
      session: { byteLength: PDF_BYTES.byteLength },
    });
  });

  it("still rejects traversal paths even when a matching file exists outside the source root", async () => {
    const fixture = await seedPreviewFixture();
    writeFileSync(join(tmp, "outside.pdf"), PDF_BYTES);
    updatePreviewFixtureDocument(fixture, { documentPath: "../outside.pdf" });

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "source-needs-rebind",
    });
  });

  it("returns a reindex repair state when a legacy filesystem source changed without a blob", async () => {
    const fixture = await seedPreviewFixture();
    disableLazyPdfBlobBackfill();
    const changed = Buffer.from(PDF_BYTES);
    changed[10] = changed[10] === 0x20 ? 0x21 : 0x20;
    writeFileSync(fixture.pdfPath, changed);

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "source-modified",
    });
  });

  it("returns a retryable dehydrated state when a cloud-backed source short-reads during verification", async () => {
    const fixture = await seedPreviewFixture();
    disableLazyPdfBlobBackfill();
    vi.spyOn(nodeWorkspaceFs, "readFileRange").mockImplementation(
      (_path, startByte, length): Promise<Uint8Array> =>
        Promise.resolve(PDF_BYTES.subarray(startByte, startByte + Math.max(0, length - 1))),
    );

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "source-dehydrated",
    });
  });

  it("does not reuse a filesystem session after the active source root is rebound", async () => {
    const fixture = await seedPreviewFixture();
    disableLazyPdfBlobBackfill();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const first = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const firstSession = (
      first.body as { readonly session: { readonly handle: string; readonly reused: boolean } }
    ).session;
    const reboundRoot = join(tmp, "rebound-source");
    mkdirSync(join(reboundRoot, "docs"), { recursive: true });
    writeFileSync(join(reboundRoot, "docs", "policy.pdf"), PDF_BYTES);
    updatePreviewFixtureSourceRoot(fixture, reboundRoot);

    const second = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const secondSession = (
      second.body as { readonly session: { readonly handle: string; readonly reused: boolean } }
    ).session;

    expect(firstSession.reused).toBe(false);
    expect(secondSession.reused).toBe(false);
    expect(secondSession.handle).not.toBe(firstSession.handle);
  });

  it("reports document-not-ready as a recoverable transient state before opening a session", async () => {
    const fixture = await seedPreviewFixture();
    updatePreviewFixtureDocument(fixture, { status: "indexing" });

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "document-not-ready",
    });
  });

  it("opens a preview session for extracted-image PDFs", async () => {
    const fixture = await seedPreviewFixture();
    updatePreviewFixtureDocument(fixture, { status: "extracted-image" });

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.body).toMatchObject({
      outcome: "authorized",
      session: { contentType: "application/pdf", byteLength: PDF_BYTES.byteLength },
    });
  });

  it("delivers PDF bytes only through a valid session handle and avoids page-fetch audit spam", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: captured.res,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(captured.headers.get("content-type")).toBe("application/pdf");
    expect(captured.headers.get("accept-ranges")).toBe("bytes");
    expect(await captured.body()).toEqual(PDF_BYTES);
    expect(auditKinds(fixture.capsuleId)).toEqual([
      "citation-preview-authorized",
      "citation-preview-document-accessed",
    ]);
  });

  it("opens and streams from a stored blob when the original PDF path is gone", async () => {
    const fixture = await seedPreviewFixture();
    writePreviewFixtureBlob(fixture);
    unlinkSync(fixture.pdfPath);
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("prefers stored blob bytes over a changed original file", async () => {
    const fixture = await seedPreviewFixture();
    writePreviewFixtureBlob(fixture);
    writeFileSync(fixture.pdfPath, Buffer.from("%PDF-1.4 changed\n%%EOF\n", "utf8"));
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("lazy-backfills a verified legacy filesystem source before streaming", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    expect(blobRefForFixture(fixture)).toBeNull();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    expect(blobRefForFixture(fixture)).toBe(fixture.previewCitation.documentContentHash);
    unlinkSync(fixture.pdfPath);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("rechecks message ownership before streaming bytes for an existing handle", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const unrelatedStore = createInMemoryUiStore();
    try {
      const result = await handleGetPdfCitationPreviewDocument(
        documentContext(handle, emptyRequest(), {} as ServerResponse),
        deps(sessionManager, unrelatedStore),
      );

      expect(result).toMatchObject({
        status: 403,
        body: { error: { code: "PREVIEW_SESSION_FORBIDDEN" } },
      });
      expect(auditKinds(fixture.capsuleId)).toEqual([
        "citation-preview-authorized",
        "citation-preview-document-accessed",
      ]);
    } finally {
      unrelatedStore.close();
    }
  });

  it("maps source drift after session open through delivery instead of access denial", async () => {
    const fixture = await seedPreviewFixture();
    disableLazyPdfBlobBackfill();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    updatePreviewFixtureDocument(fixture, { contentHash: "hash-drifted" });

    const result = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), {} as ServerResponse),
      deps(sessionManager),
    );

    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: "PREVIEW_SOURCE_CHANGED" } },
    });
  });

  it("supports bounded single-range delivery for later PDF.js consumption", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest({ range: "bytes=0-3" }),
        res: captured.res,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(206);
    expect(captured.headers.get("content-range")).toBe(`bytes 0-3/${String(PDF_BYTES.byteLength)}`);
    expect(await captured.body()).toEqual(PDF_BYTES.subarray(0, 4));
  });

  it("keeps explicit range requests as 206 even when the bounded range reaches EOF", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest({ range: "bytes=0-99" }), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(206);
    expect(captured.headers.get("content-range")).toBe(
      `bytes 0-${String(PDF_BYTES.byteLength - 1)}/${String(PDF_BYTES.byteLength)}`,
    );
    expect(captured.headers.get("content-length")).toBe(String(PDF_BYTES.byteLength));
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("supports RFC suffix ranges and rejects unsafe range edge cases", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();

    const suffix = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest({ range: "bytes=-4" }), captured.res),
      deps(sessionManager),
    );

    expect(suffix).toBe(STREAMING);
    expect(captured.statusCode()).toBe(206);
    expect(captured.headers.get("content-range")).toBe(
      `bytes ${String(PDF_BYTES.byteLength - 4)}-${String(PDF_BYTES.byteLength - 1)}/${String(
        PDF_BYTES.byteLength,
      )}`,
    );
    expect(await captured.body()).toEqual(PDF_BYTES.subarray(PDF_BYTES.byteLength - 4));

    for (const range of ["bytes=-0", "bytes=0-9007199254740992", "bytes=NaN-10"]) {
      const invalid = await handleGetPdfCitationPreviewDocument(
        documentContext(handle, emptyRequest({ range }), {} as ServerResponse),
        deps(sessionManager),
      );
      expect(invalid).toMatchObject({
        status: 416,
        body: { error: { code: "PREVIEW_RANGE_NOT_SATISFIABLE" } },
      });
    }
  });

  it("caps no-range delivery for large PDFs and reports the prefix as a partial response", async () => {
    const largeBytes = Buffer.concat([
      PDF_BYTES,
      Buffer.alloc(MAX_PDF_PREVIEW_RANGE_BYTES + 128, 0x20),
    ]);
    const fixture = await seedPreviewFixture({ bytes: largeBytes });
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(206);
    expect(captured.headers.get("content-range")).toBe(
      `bytes 0-${String(MAX_PDF_PREVIEW_RANGE_BYTES - 1)}/${String(largeBytes.byteLength)}`,
    );
    expect(captured.headers.get("content-length")).toBe(String(MAX_PDF_PREVIEW_RANGE_BYTES));
    const body = await captured.body();
    expect(body.byteLength).toBe(MAX_PDF_PREVIEW_RANGE_BYTES);
    expect(body.subarray(0, PDF_BYTES.byteLength)).toEqual(PDF_BYTES);
    expect(body.at(-1)).toBe(0x20);
  }, 10_000);

  it("sets ETag and returns 304 for matching no-range conditionals", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const captured = captureResponse();
    const etag = `"${sha256Hex(PDF_BYTES)}"`;

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest({ "if-none-match": etag }), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(304);
    expect(captured.headers.get("etag")).toBe(etag);
    expect(await captured.body()).toEqual(Buffer.alloc(0));
  });

  it("opens one reusable file reader for a multi-chunk range response", async () => {
    const largeBytes = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024, 0x20)]);
    const fixture = await seedPreviewFixture({ bytes: largeBytes });
    const sessionManager = createPdfCitationPreviewSessionManager();
    disableLazyPdfBlobBackfill();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const openReaderSpy = vi.spyOn(nodeWorkspaceFs, "openFileReader");
    const readRangeSpy = vi.spyOn(nodeWorkspaceFs, "readFileRange");
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(
        handle,
        emptyRequest({ range: `bytes=0-${String(largeBytes.byteLength - 1)}` }),
        captured.res,
      ),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(openReaderSpy).toHaveBeenCalledTimes(1);
    expect(readRangeSpy).not.toHaveBeenCalled();
    expect(await captured.body()).toEqual(largeBytes);
  }, 10_000);

  it("returns a retryable error and closes the reader when the first read is short", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    disableLazyPdfBlobBackfill();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const close = vi.fn((): Promise<void> => Promise.resolve());
    vi.spyOn(nodeWorkspaceFs, "openFileReader").mockResolvedValue({
      readRange: (startByte: number, length: number): Promise<Uint8Array> =>
        Promise.resolve(PDF_BYTES.subarray(startByte, startByte + Math.max(0, length - 1))),
      close,
    });

    const result = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captureResponse().res),
      deps(sessionManager),
    );

    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "PREVIEW_SOURCE_DEHYDRATED" } },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable error when a later bounded range read is short", async () => {
    const largeBytes = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024, 0x20)]);
    const fixture = await seedPreviewFixture({ bytes: largeBytes });
    const sessionManager = createPdfCitationPreviewSessionManager();
    disableLazyPdfBlobBackfill();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const close = vi.fn((): Promise<void> => Promise.resolve());
    let reads = 0;
    const readRange = vi.fn((startByte: number, length: number): Promise<Uint8Array> => {
      reads += 1;
      const chunk = largeBytes.subarray(startByte, startByte + length);
      return Promise.resolve(
        reads === 1 ? chunk : chunk.subarray(0, Math.max(0, chunk.byteLength - 1)),
      );
    });
    vi.spyOn(nodeWorkspaceFs, "openFileReader").mockResolvedValue({
      readRange,
      close,
    });
    const result = await handleGetPdfCitationPreviewDocument(
      documentContext(
        handle,
        emptyRequest({ range: `bytes=0-${String(largeBytes.byteLength - 1)}` }),
        captureResponse().res,
      ),
      deps(sessionManager),
    );

    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "PREVIEW_SOURCE_DEHYDRATED" } },
    });
    expect(readRange).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not hang on missing drain and closes the reader when the response closes", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    disableLazyPdfBlobBackfill();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const close = vi.fn((): Promise<void> => Promise.resolve());
    vi.spyOn(nodeWorkspaceFs, "openFileReader").mockResolvedValue({
      readRange: (startByte: number, length: number): Promise<Uint8Array> =>
        Promise.resolve(PDF_BYTES.subarray(startByte, startByte + length)),
      close,
    });
    const captured = captureResponse();
    const write = vi.fn((): boolean => {
      setImmediate(() => captured.res.emit("close"));
      return false;
    });
    (captured.res as ServerResponse & { write: typeof write }).write = write;

    const outcome = await handleGetPdfCitationPreviewDocument(
      documentContext(handle, emptyRequest(), captured.res),
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects delivery for a missing or unknown session handle", async () => {
    const result = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: {} as ServerResponse,
        params: { sessionHandle: "missing-handle" },
        url: new URL(
          "http://127.0.0.1/api/local-knowledge/citation-preview/sessions/missing-handle/document",
        ),
      },
      deps(),
    );

    expect(result).toMatchObject({
      status: 404,
      body: { error: { code: "PREVIEW_SESSION_NOT_FOUND" } },
    });
  });

  it("invalidates further delivery when the session is explicitly closed", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;

    const closed = await handleClosePdfCitationPreviewSession(
      {
        req: emptyRequest(),
        res: {} as never,
        params: { sessionHandle: handle },
        url: new URL(`http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}`),
      },
      deps(sessionManager),
    );
    const afterClose = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: {} as ServerResponse,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(closed).toMatchObject({ status: 200, body: { ok: true } });
    expect(afterClose).toMatchObject({
      status: 410,
      body: { error: { code: "PREVIEW_SESSION_CLOSED" } },
    });
  });

  it("rejects cross-site document fetch metadata before session lookup", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);

    const rejected = await handleGetPdfCitationPreviewDocument(
      documentContext(
        handle,
        emptyRequest({
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "cross-site",
        }),
        {} as ServerResponse,
      ),
      deps(sessionManager),
    );

    expect(rejected).toMatchObject({
      status: 403,
      body: { error: { code: "FORBIDDEN_CSRF" } },
    });
    expect(sessionManager.lookupSession(handle).kind).toBe("open");
  });

  it("keeps close idempotent but does not close when stored context is no longer authorized", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const foreignStore = createInMemoryUiStore();
    try {
      const closed = await handleClosePdfCitationPreviewSession(
        {
          req: emptyRequest(),
          res: {} as never,
          params: { sessionHandle: handle },
          url: new URL(`http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}`),
        },
        deps(sessionManager, foreignStore),
      );

      expect(closed).toMatchObject({ status: 200, body: { ok: true } });
      expect(sessionManager.lookupSession(handle).kind).toBe("open");
    } finally {
      foreignStore.close();
    }
  });

  it("does not close a refreshed session when the close version is stale", async () => {
    let nowMs = 1_700_000_000_000;
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager({
      now: () => nowMs,
      ttlMs: 5 * 60_000,
      autoSweep: false,
    });
    const handle = await openPreviewSessionHandle(fixture, sessionManager);
    const firstLookup = sessionManager.lookupSession(handle);
    if (firstLookup.kind !== "open") throw new Error("expected open session");
    const staleExpiresAt = firstLookup.session.expiresAt;

    nowMs += 1_000;
    const reopened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    expect(
      (reopened.body as { readonly session: { readonly handle: string } }).session.handle,
    ).toBe(handle);

    const closed = await handleClosePdfCitationPreviewSession(
      {
        req: request({ expectedExpiresAt: staleExpiresAt }),
        res: {} as never,
        params: { sessionHandle: handle },
        url: new URL(`http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}`),
      },
      deps(sessionManager),
    );

    expect(closed).toMatchObject({ status: 200, body: { ok: true } });
    expect(sessionManager.lookupSession(handle).kind).toBe("open");
  });

  it("expires sessions and fails closed until the citation is actively re-opened", async () => {
    let nowMs = 1_700_000_000_000;
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager({
      now: () => nowMs,
      ttlMs: 50,
      autoSweep: false,
    });
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    nowMs += 60;

    const expired = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: {} as ServerResponse,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(expired).toMatchObject({
      status: 410,
      body: { error: { code: "PREVIEW_SESSION_EXPIRED" } },
    });
  });

  it("extends active session lookups without reviving closed or expired sessions", async () => {
    let nowMs = 1_700_000_000_000;
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager({
      now: () => nowMs,
      ttlMs: 50,
      autoSweep: false,
    });
    const first = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const firstHandle = (first.body as { readonly session: { readonly handle: string } }).session
      .handle;

    nowMs += 30;
    const touched = sessionManager.lookupSession(firstHandle);
    expect(touched.kind).toBe("open");
    if (touched.kind !== "open") throw new Error("expected open session");
    expect(Date.parse(touched.session.expiresAt)).toBe(nowMs + 50);

    expect(sessionManager.closeSession(firstHandle)).toBe(true);
    nowMs += 10;
    expect(sessionManager.lookupSession(firstHandle).kind).toBe("closed");

    const second = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const secondHandle = (second.body as { readonly session: { readonly handle: string } }).session
      .handle;
    nowMs += 60;
    expect(sessionManager.lookupSession(secondHandle).kind).toBe("expired");
    nowMs += 10;
    expect(sessionManager.lookupSession(secondHandle).kind).toBe("expired");
  });

  it("retains settled sessions until explicit sweep instead of cleaning them during lookup", async () => {
    let nowMs = 1_700_000_000_000;
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager({
      now: () => nowMs,
      ttlMs: 50,
      autoSweep: false,
    });
    const handle = await openPreviewSessionHandle(fixture, sessionManager);

    expect(sessionManager.closeSession(handle)).toBe(true);
    nowMs += 10 * 60_000 + 1;
    expect(sessionManager.lookupSession(handle).kind).toBe("closed");

    sessionManager.sweep();

    expect(sessionManager.lookupSession(handle).kind).toBe("missing");
  });

  it("keeps an active document use open across sweep until the stream completes", async () => {
    let nowMs = 1_700_000_000_000;
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager({
      now: () => nowMs,
      ttlMs: 50,
      autoSweep: false,
    });
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;

    expect(sessionManager.beginSessionUse(handle).kind).toBe("open");
    nowMs += 60;
    sessionManager.sweep();

    const duringUse = sessionManager.lookupSession(handle);
    expect(duringUse.kind).toBe("open");
    sessionManager.endSessionUse(handle);
    const afterUse = sessionManager.lookupSession(handle);
    expect(afterUse.kind).toBe("open");
  });

  it("continues delivery from the captured blob when the source bytes change after the session was opened", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    writeFileSync(fixture.pdfPath, Buffer.from("%PDF-1.4 changed\n%%EOF\n", "utf8"));
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: captured.res,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("continues delivery when only source mtime changes after the session was opened", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    utimesSync(
      fixture.pdfPath,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: captured.res,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("continues delivery from the captured blob when the verified source disappears after session creation", async () => {
    const fixture = await seedPreviewFixture();
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;
    unlinkSync(fixture.pdfPath);
    const captured = captureResponse();

    const outcome = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest(),
        res: captured.res,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(outcome).toBe(STREAMING);
    expect(captured.statusCode()).toBe(200);
    expect(await captured.body()).toEqual(PDF_BYTES);
  });

  it("rejects non-PDF preview opens before creating a session", async () => {
    const fixture = await seedPreviewFixture({ mediaType: "text/plain" });

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "blocked",
      reason: "document-not-pdf",
    });
  });

  it("rejects PDFs above the preview size ceiling before creating a session", async () => {
    const fixture = await seedPreviewFixture({
      documentSizeBytes: MAX_PDF_PREVIEW_BYTES + 1,
    });

    const result = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: "rejected",
      state: "recoverable",
      reason: "preview-source-oversized",
    });
  });

  it("rejects invalid multi-range requests instead of broadening delivery semantics", async () => {
    const fixture = await seedPreviewFixture({
      bytes: Buffer.concat([PDF_BYTES, Buffer.alloc(MAX_PDF_PREVIEW_RANGE_BYTES + 16, 0x20)]),
    });
    const sessionManager = createPdfCitationPreviewSessionManager();
    const opened = await handleOpenPdfCitationPreviewSession(
      ctx("/api/local-knowledge/citation-preview/open", {
        chatId: fixture.chatId,
        assistantMessageId: fixture.assistantMessageId,
        marker: "[1]",
        stableId: fixture.previewCitation.stableId,
      }),
      deps(sessionManager),
    );
    const handle = (opened.body as { readonly session: { readonly handle: string } }).session
      .handle;

    const invalid = await handleGetPdfCitationPreviewDocument(
      {
        req: emptyRequest({ range: "bytes=0-4,6-10" }),
        res: {} as ServerResponse,
        params: { sessionHandle: handle },
        url: new URL(
          `http://127.0.0.1/api/local-knowledge/citation-preview/sessions/${handle}/document`,
        ),
      },
      deps(sessionManager),
    );

    expect(invalid).toMatchObject({
      status: 416,
      body: { error: { code: "PREVIEW_RANGE_NOT_SATISFIABLE" } },
    });
  });
});
