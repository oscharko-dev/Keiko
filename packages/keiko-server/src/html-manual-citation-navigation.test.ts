// Epic #1854 x Epic #1856 seam regression (AUDIT-E1854-001) — a citation handle captured before a
// manual refresh must not silently resolve to a different page after that refresh prunes the page
// the citation pointed at. `chunkBelongsToDocument` re-verifies chunk-to-document lineage at
// citation-open time, and `refreshHtmlManualPod` deletes the pruned page's document (and its
// dependent chunk rows) on a real removal; this proves those two independently-tested behaviours
// still compose correctly end to end: create a pod, capture a citation for a page, refresh with
// that page gone, and confirm the stale handle fails closed rather than resolving.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type ChunkId,
  type DocumentId,
  type EmbeddingModelIdentity,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createHtmlManualPod,
  createInMemoryManualFetcher,
  openKnowledgeStore,
  refreshHtmlManualPod,
  resolveKnowledgeStorePath,
  type InMemoryManualPage,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import { scriptedAdapter } from "@oscharko-dev/keiko-local-knowledge/testing";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import {
  buildHtmlManualCitationNavigationTarget,
  resolveHtmlManualCitationNavigationTarget,
} from "./html-manual-citation-navigation.js";
import { createRunRegistry } from "./runs.js";

const CAPSULE_ID = "cap-citation-refresh-seam" as KnowledgeCapsuleId;
const SOURCE_ID = "src-citation-refresh-seam" as KnowledgeSourceId;

const HOME = "https://docs.internal/";
const REFERENCE = "https://docs.internal/reference.html";

const EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:3ff5f7fb35874f7a6b414af6",
};

function manualPage(heading: string, links: readonly string[] = []): InMemoryManualPage {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  return {
    html: `<!doctype html><html><head><title>${heading}</title></head><body>
      <main><h1>${heading}</h1><p>${heading} content paragraph with enough words to chunk.</p>
      ${anchors}</main></body></html>`,
  };
}

function manualPages(includeReference: boolean): Map<string, InMemoryManualPage> {
  const links = includeReference ? ["reference.html"] : [];
  const pages = new Map<string, InMemoryManualPage>([[HOME, manualPage("Home", links)]]);
  if (includeReference) pages.set(REFERENCE, manualPage("Reference"));
  return pages;
}

interface ChunkRow {
  readonly id: ChunkId;
  readonly document_id: DocumentId;
}

function findChunkForDocument(store: KnowledgeStore, documentId: DocumentId): ChunkRow {
  const row = store._internal.db
    .prepare("SELECT id, document_id FROM chunks WHERE capsule_id = :c AND document_id = :d")
    .get({ c: CAPSULE_ID, d: documentId }) as ChunkRow | undefined;
  if (row === undefined) throw new Error(`no chunk persisted for document ${documentId}`);
  return row;
}

interface DocumentRow {
  readonly id: DocumentId;
  readonly document_path: string;
}

function findDocumentByPath(store: KnowledgeStore, documentPath: string): DocumentRow {
  const row = store._internal.db
    .prepare(
      "SELECT id, document_path FROM documents WHERE capsule_id = :c AND source_id = :s AND document_path = :p",
    )
    .get({ c: CAPSULE_ID, s: SOURCE_ID, p: documentPath }) as DocumentRow | undefined;
  if (row === undefined) throw new Error(`no document persisted for path ${documentPath}`);
  return row;
}

describe("resolveHtmlManualCitationNavigationTarget — refresh seam (#1854 x #1856)", () => {
  let staticRoot: string;
  let deps: UiHandlerDeps;
  let store: KnowledgeStore;

  beforeEach(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), "keiko-citation-refresh-seam-"));
    await writeFile(join(staticRoot, "index.html"), "<html><body>docs</body></html>", "utf8");
    const uiDbPath = join(staticRoot, "ui.sqlite");
    deps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: (): string => "",
        list: (): readonly string[] => [],
        get: (): undefined => undefined,
        delete: (): undefined => undefined,
      },
      env: process.env,
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (): undefined => undefined,
      store: createInMemoryUiStore(),
      uiDbPath,
    };
    store = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: staticRoot }),
    });
    await createHtmlManualPod(
      {
        store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: scriptedAdapter({ identity: EMBEDDING_IDENTITY }),
        embeddingModelIdentity: EMBEDDING_IDENTITY,
        fetcher: createInMemoryManualFetcher(manualPages(true)),
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
      },
      {
        schemaVersion: "1",
        scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
        limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        sourceFingerprint: "fp-citation-refresh-seam",
        proposedPodName: "Citation Refresh Seam Manual",
      },
    );
  });

  afterEach(async () => {
    store.close();
    deps.store.close();
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("fails closed with citation-lineage-mismatch when a later refresh prunes the cited page", async () => {
    const referenceDocument = findDocumentByPath(store, "reference.html");
    const referenceChunk = findChunkForDocument(store, referenceDocument.id);
    const target = buildHtmlManualCitationNavigationTarget({
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
      documentId: referenceDocument.id,
      chunkId: referenceChunk.id,
    });

    // Sanity: the handle resolves before the refresh removes its page.
    const beforeRefresh = resolveHtmlManualCitationNavigationTarget(deps, target);
    expect(beforeRefresh.kind).toBe("resolved");

    await refreshHtmlManualPod({
      store,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: scriptedAdapter({ identity: EMBEDDING_IDENTITY }),
      fetcher: createInMemoryManualFetcher(manualPages(false)),
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
    });

    // The pruned page's document (and dependent chunk row) must be gone.
    expect(() => findDocumentByPath(store, "reference.html")).toThrow();

    const afterRefresh = resolveHtmlManualCitationNavigationTarget(deps, target);
    expect(afterRefresh.kind).toBe("failed");
    if (afterRefresh.kind === "failed") {
      expect(afterRefresh.reason).toBe("citation-lineage-mismatch");
    }
  });
});
