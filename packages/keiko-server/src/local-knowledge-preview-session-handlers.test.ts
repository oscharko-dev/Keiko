import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";

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
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(
  sessionManager: PdfCitationPreviewSessionManager = createPdfCitationPreviewSessionManager(),
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
    store,
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
  const stream = new PassThrough();
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let statusCode = 200;
  const endStream = stream.end.bind(stream);
  stream.on("data", (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
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
      await new Promise<void>((resolve) => stream.on("end", resolve));
      return Buffer.concat(chunks);
    },
    statusCode: (): number => statusCode,
  };
}

describe("local-knowledge preview session handlers", () => {
  it("normalizes supported preview marker bracket variants", () => {
    expect(normalizePreviewMarkerIndex("[1]")).toBe(1);
    expect(normalizePreviewMarkerIndex("1")).toBe(1);
    expect(normalizePreviewMarkerIndex("［1］")).toBe(1);
    expect(normalizePreviewMarkerIndex("【1】")).toBe(1);
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
    expect(auditKinds(fixture.capsuleId)).toEqual(["citation-preview-authorized"]);
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

    const closed = handleClosePdfCitationPreviewSession(
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

  it("fails closed when the source bytes change after the session was opened", async () => {
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

    const changed = await handleGetPdfCitationPreviewDocument(
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

    expect(changed).toMatchObject({
      status: 409,
      body: { error: { code: "PREVIEW_SOURCE_CHANGED" } },
    });
  });

  it("fails closed when the verified source disappears after session creation", async () => {
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

    const missing = await handleGetPdfCitationPreviewDocument(
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

    expect(missing).toMatchObject({
      status: 410,
      body: { error: { code: "PREVIEW_SOURCE_MISSING" } },
    });
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
