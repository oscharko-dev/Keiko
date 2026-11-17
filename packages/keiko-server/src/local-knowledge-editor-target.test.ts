import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeSourceScope,
  KnowledgeCitationEditorTargetRequest,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateSourceScopeInCapsule,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import type { UiHandlerDeps } from "./deps.js";
import * as files from "./files.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { buildStoredPreviewCitations } from "./local-knowledge-preview-authority.js";
import { getPdfCitationPreviewStatus } from "./local-knowledge-preview-service.js";
import { API_ROUTES, type HandlerOutcome, type RouteContext, type RouteResult } from "./routes.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

const ROUTE = "/api/local-knowledge/citation-preview/editor-target";
const CONTENT = "A tiny synthetic knowledge source.\n";
let tmp: string;
let store: UiStore;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "citation-editor-")));
  store = createInMemoryUiStore();
});
afterEach(() => {
  vi.restoreAllMocks();
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

function knowledgeStore(): KnowledgeStore {
  return openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }) });
}

interface CitationFixture {
  readonly root: string;
  readonly citation: StoredPdfCitationPreviewCitation;
  readonly seeded: Awaited<ReturnType<typeof seedCapsuleWithVectors>>;
  readonly selection: KnowledgeCitationEditorTargetRequest;
}

async function fixture(filePath = "guide.txt"): Promise<CitationFixture> {
  const root = join(tmp, "source");
  mkdirSync(dirname(join(root, filePath)), { recursive: true });
  writeFileSync(join(root, filePath), CONTENT);
  const knowledge = knowledgeStore();
  const seeded = await seedCapsuleWithVectors(knowledge, {
    text: CONTENT,
    safeDisplayName: "guide.txt",
    contentHash: createHash("sha256").update(CONTENT).digest("hex"),
  });
  updateSourceScopeInCapsule(knowledge, seeded.capsuleId, seeded.sourceId, {
    kind: "folder",
    rootPath: root,
    recursive: true,
  });
  knowledge._internal.db
    .prepare(
      "UPDATE documents SET document_path = :path, media_type = 'text/plain', status = 'extracted', size_bytes = :size WHERE id = :id",
    )
    .run({ path: filePath, size: Buffer.byteLength(CONTENT), id: String(seeded.documentId) });
  const chunkId = seeded.chunkIds[0];
  if (chunkId === undefined) throw new Error("Missing fixture chunk");
  const lineage = {
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    chunkId,
  };
  const citations = buildStoredPreviewCitations(knowledge, [
    {
      marker: "[1]",
      reference: {
        capsuleId: seeded.capsuleId,
        chunkId,
        score: 1,
        citation: { ...lineage, safeDisplayName: "guide.txt" },
      },
    },
  ]);
  knowledge.close();
  const citation = citations[0];
  if (citation === undefined) throw new Error("Missing stored fixture citation");
  const project = store.createProject(tmp, "Synthetic project");
  const chat = store.createChat(project.path, "Synthetic chat", "fixture-model");
  const message = store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "A source [1].",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  store.attachGroundedAnswer(
    message.id,
    {
      groundingKind: "local-knowledge",
      userMessageId: "fixture-user",
      assistantMessageId: message.id,
      content: "A source [1].",
      citations: [
        {
          stableId: citation.stableId,
          marker: "[1]",
          label: "misleading-model-label.txt",
          score: 1,
          lineage,
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 1,
      noEvidence: false,
      contextPack: {
        kind: "local-knowledge",
        scopeKind: "capsule",
        scopeId: String(seeded.capsuleId),
        scopeLabel: "Synthetic pod",
        capsuleCount: 1,
        sourceCount: 1,
        citationCount: 1,
        referenceBudget: 16,
        referencesUsed: 1,
      },
    },
    citations,
  );
  return {
    root,
    citation,
    seeded,
    selection: {
      chatId: chat.id,
      assistantMessageId: message.id,
      marker: "[1]",
      stableId: citation.stableId,
    },
  };
}

async function openTarget(body: object, handlerDeps = deps()): Promise<HandlerOutcome> {
  const route = API_ROUTES.find(
    (candidate) => candidate.method === "POST" && candidate.pattern === ROUTE,
  );
  expect(route, "the citation-owned Editor route is mounted").toBeDefined();
  if (route === undefined) throw new Error("Missing Editor target route");
  const ctx: RouteContext = {
    correlationId: undefined,
    req: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      headers: {},
    }) as unknown as IncomingMessage,
    res: {} as never,
    params: {},
    url: new URL(`http://127.0.0.1${ROUTE}`),
  };
  return route.handler(ctx, handlerDeps);
}

function changeDocument(
  sample: Awaited<ReturnType<typeof fixture>>,
  sql: string,
  params: Record<string, string | number> = {},
): void {
  const knowledge = knowledgeStore();
  try {
    knowledge._internal.db
      .prepare(`UPDATE documents SET ${sql} WHERE id = :id`)
      .run({ ...params, id: String(sample.seeded.documentId) });
  } finally {
    knowledge.close();
  }
}

function changeScope(sample: CitationFixture, scope: KnowledgeSourceScope): void {
  const knowledge = knowledgeStore();
  try {
    updateSourceScopeInCapsule(knowledge, sample.seeded.capsuleId, sample.seeded.sourceId, scope);
  } finally {
    knowledge.close();
  }
}

function replaceCitations(
  sample: Awaited<ReturnType<typeof fixture>>,
  citations: readonly StoredPdfCitationPreviewCitation[] | undefined,
): void {
  const answer = store.findMessageById(sample.selection.assistantMessageId)?.groundedAnswer;
  if (answer === undefined) throw new Error("Missing fixture answer");
  store.attachGroundedAnswer(sample.selection.assistantMessageId, answer, citations);
}

function refused(reason: string): RouteResult {
  return { status: 200, body: { outcome: "rejected", reason } };
}

describe("provenance-bound Knowledge citation Editor target", () => {
  it("offers a text citation using the stored stable identity without making it a PDF", async () => {
    const sample = await fixture();
    expect(getPdfCitationPreviewStatus(deps(), sample.selection)).toMatchObject({
      citations: [
        {
          stableId: sample.citation.stableId,
          state: "not-applicable",
          editorOpenAvailable: true,
        },
      ],
    });
  });

  it("opens the exact live text source instead of a model label or active project root", async () => {
    const sample = await fixture();
    expect(await openTarget(sample.selection)).toEqual({
      status: 200,
      body: {
        outcome: "authorized",
        target: { root: sample.root, path: "guide.txt" },
      },
    });
  });

  it("preserves the canonical nested source path including spaces and punctuation", async () => {
    const path = "source notes/Guide - Alpha.txt";
    const sample = await fixture(path);
    expect(await openTarget(sample.selection)).toEqual({
      status: 200,
      body: {
        outcome: "authorized",
        target: { root: sample.root, path },
      },
    });
  });

  it("verifies raw UTF-8 bytes even when the ordinary Editor removes a BOM on decode", async () => {
    const sample = await fixture();
    const bytes = Buffer.from(`\uFEFF${CONTENT}`, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(sample.root, "guide.txt"), bytes);
    changeDocument(sample, "size_bytes = :size, content_hash = :hash", {
      size: bytes.length,
      hash,
    });
    replaceCitations(sample, [{ ...sample.citation, documentContentHash: hash }]);
    expect(await openTarget(sample.selection)).toMatchObject({ body: { outcome: "authorized" } });
  });

  it.each([
    ["chatId", "foreign-chat", "assistant-message-chat-mismatch"],
    ["assistantMessageId", "foreign-message", "assistant-message-not-found"],
    ["stableId", "foreign-citation", "stable-id-mismatch"],
    ["marker", "[2]", "citation-not-found"],
  ])("refuses a mismatched %s without returning a path", async (field, value, reason) => {
    const sample = await fixture();
    expect(await openTarget({ ...sample.selection, [field]: value })).toEqual(refused(reason));
  });

  it("rejects client path injection and absent stable identity", async () => {
    const sample = await fixture();
    expect(
      await openTarget({ ...sample.selection, root: sample.root, path: "guide.txt" }),
    ).toMatchObject({ status: 400 });
    expect(await openTarget({ ...sample.selection, stableId: "" })).toMatchObject({ status: 400 });
    const { stableId: _stableId, ...missingStableId } = sample.selection;
    expect(await openTarget(missingStableId)).toMatchObject({ status: 400 });
  });

  it("does not grant authority from missing or conflicting stored provenance", async () => {
    const sample = await fixture();
    replaceCitations(sample, undefined);
    expect(await openTarget(sample.selection)).toEqual(refused("preview-metadata-missing"));
    replaceCitations(sample, [
      sample.citation,
      { ...sample.citation, documentContentHash: "b".repeat(64) },
    ]);
    expect(await openTarget(sample.selection)).toEqual(refused("citation-not-found"));
    expect(
      getPdfCitationPreviewStatus(deps(), sample.selection).citations.every(
        (value) => value.editorOpenAvailable !== true,
      ),
    ).toBe(true);
  });

  it.each(["files", "repository", "shallow", "included", "excluded"])(
    "does not widen a %s source into an Editor folder",
    async (kind) => {
      const sample = await fixture();
      const scopes: Record<string, KnowledgeSourceScope> = {
        files: { kind: "files", rootPath: sample.root, files: ["guide.txt"] },
        repository: { kind: "repository", repositoryRoot: sample.root },
        shallow: { kind: "folder", rootPath: sample.root, recursive: false },
        included: {
          kind: "folder",
          rootPath: sample.root,
          recursive: true,
          includeGlobs: ["*.txt"],
        },
        excluded: {
          kind: "folder",
          rootPath: sample.root,
          recursive: true,
          excludeGlobs: ["private/**"],
        },
      };
      const scope = scopes[kind];
      if (scope === undefined) throw new Error("Missing fixture source scope");
      changeScope(sample, scope);
      expect(await openTarget(sample.selection)).toEqual(refused("editor-scope-unsupported"));
      expect(getPdfCitationPreviewStatus(deps(), sample.selection).citations[0]).not.toHaveProperty(
        "editorOpenAvailable",
      );
    },
  );

  it.each([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ])("keeps unsupported %s outside the Editor route", async (media) => {
    const sample = await fixture();
    changeDocument(sample, "media_type = :media", { media });
    replaceCitations(sample, [{ ...sample.citation, documentMediaType: media }]);
    expect(await openTarget(sample.selection)).toEqual(refused("editor-source-unsupported"));
  });

  it("refuses a changed indexed document revision", async () => {
    const sample = await fixture();
    changeDocument(sample, "content_hash = :hash", { hash: "b".repeat(64) });
    expect(await openTarget(sample.selection)).toEqual(refused("document-content-mismatch"));
  });

  it("refuses same-length live changes even while the indexed revision remains unchanged", async () => {
    const sample = await fixture();
    writeFileSync(join(sample.root, "guide.txt"), CONTENT.replace("tiny", "fake"));
    expect(await openTarget(sample.selection)).toEqual(refused("source-modified"));
  });

  it("refuses a source removed since the saved citation", async () => {
    const sample = await fixture();
    rmSync(join(sample.root, "guide.txt"));
    expect(await openTarget(sample.selection)).toMatchObject({
      status: 200,
      body: { outcome: "rejected" },
    });
  });

  it.each(["contained", "outside"])(
    "refuses a %s symlink even with identical bytes",
    async (where) => {
      const sample = await fixture();
      const actual = join(where === "contained" ? sample.root : tmp, "other.txt");
      writeFileSync(actual, CONTENT);
      rmSync(join(sample.root, "guide.txt"));
      symlinkSync(actual, join(sample.root, "guide.txt"));
      expect(await openTarget(sample.selection)).toMatchObject({
        status: 200,
        body: { outcome: "rejected" },
      });
    },
  );

  it("keeps the ordinary Editor's UTF-8, byte and sensitive-path denials", async () => {
    const sample = await fixture();
    writeFileSync(join(sample.root, "guide.txt"), Buffer.from([0xff, 0, 0x41]));
    changeDocument(sample, "size_bytes = 3");
    expect(await openTarget(sample.selection)).toEqual(refused("editor-read-refused"));
    writeFileSync(join(sample.root, "guide.txt"), "x".repeat(1_000_001));
    changeDocument(sample, "size_bytes = 1000001");
    expect(await openTarget(sample.selection)).toEqual(refused("editor-read-refused"));
    writeFileSync(join(sample.root, ".env"), CONTENT);
    changeDocument(sample, "document_path = '.env', size_bytes = :size", {
      size: Buffer.byteLength(CONTENT),
    });
    expect(await openTarget(sample.selection)).toMatchObject({ body: { outcome: "rejected" } });
  });

  it("does not bypass the managed-root app-session read authority", async () => {
    const sample = await fixture();
    expect(
      await openTarget(sample.selection, { ...deps(), managedTaskWorkspaceRoot: sample.root }),
    ).toEqual(refused("editor-read-refused"));
  });

  it("rechecks source scope after the awaited content read", async () => {
    const sample = await fixture();
    const readRange = nodeWorkspaceFs.readFileRange;
    if (readRange === undefined) throw new Error("Missing descriptor read port");
    vi.spyOn(nodeWorkspaceFs, "readFileRange").mockImplementationOnce(async (...args) => {
      changeScope(sample, { kind: "files", rootPath: sample.root, files: ["guide.txt"] });
      return readRange(...args);
    });
    expect(await openTarget(sample.selection)).toEqual(refused("editor-scope-unsupported"));
  });

  it("does not outlive deletion of the owning chat during an awaited read", async () => {
    const sample = await fixture();
    const readRange = nodeWorkspaceFs.readFileRange;
    if (readRange === undefined) throw new Error("Missing descriptor read port");
    vi.spyOn(nodeWorkspaceFs, "readFileRange").mockImplementationOnce(async (...args) => {
      store.deleteChat(sample.selection.chatId);
      return readRange(...args);
    });
    expect(await openTarget(sample.selection)).toEqual(refused("assistant-message-not-found"));
  });

  it("revalidates citation ownership after the final request-root guard awaits", async () => {
    const sample = await fixture();
    const resolveRoot = files.resolveRequestRoot;
    let calls = 0;
    vi.spyOn(files, "resolveRequestRoot").mockImplementation(async (...args) => {
      const result = await resolveRoot(...args);
      calls += 1;
      if (calls === 2) store.deleteChat(sample.selection.chatId);
      return result;
    });
    expect(await openTarget(sample.selection)).toEqual(refused("assistant-message-not-found"));
  });

  it("revalidates the verified file snapshot after the final request-root guard awaits", async () => {
    const sample = await fixture();
    const resolveRoot = files.resolveRequestRoot;
    let calls = 0;
    vi.spyOn(files, "resolveRequestRoot").mockImplementation(async (...args) => {
      const result = await resolveRoot(...args);
      calls += 1;
      if (calls === 2)
        writeFileSync(join(sample.root, "guide.txt"), CONTENT.replace("tiny", "fake"));
      return result;
    });
    expect(await openTarget(sample.selection)).toEqual(refused("source-modified"));
  });
});
