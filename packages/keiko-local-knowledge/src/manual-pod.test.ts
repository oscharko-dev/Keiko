import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  sealedLocalPodModelUsePolicy,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import { createInMemoryManualFetcher, type InMemoryManualPage } from "./crawl/index.js";
import { createHtmlManualPod, type CreateHtmlManualPodDeps } from "./manual-pod.js";
import {
  persistHtmlManualSourceMetadata,
  readHtmlManualSourceMetadata,
  resolveHtmlManualCitationTarget,
} from "./manual-source-metadata.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import type { KnowledgeStore } from "./store.js";
import { scriptedAdapter } from "./testing.js";

let store: KnowledgeStore;
let cleanup: () => void;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
});

afterEach(() => {
  cleanup();
});

function manualPage(heading: string, links: readonly string[] = []): InMemoryManualPage {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  return {
    html: `<!doctype html><html><head><title>${heading}</title></head><body>
      <main><h1>${heading}</h1><p>${heading} content paragraph with enough words to chunk.</p>
      ${anchors}</main></body></html>`,
  };
}

const MANUAL_PAGES = new Map<string, InMemoryManualPage>([
  ["https://docs.internal/", manualPage("Home", ["guide.html", "reference.html"])],
  ["https://docs.internal/guide.html", manualPage("Guide", ["/"])],
  ["https://docs.internal/reference.html", manualPage("Reference")],
]);

function httpManualSource(proposedPodName = "Product Handbook"): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-docs-internal",
    proposedPodName,
  };
}

function podDeps(fetcherPages: Map<string, InMemoryManualPage>): CreateHtmlManualPodDeps {
  return {
    store,
    parserRegistry: createDefaultParserRegistry(),
    embeddingAdapter: scriptedAdapter({ identity: DEFAULT_EMBEDDING }),
    embeddingModelIdentity: DEFAULT_EMBEDDING,
    fetcher: createInMemoryManualFetcher(fetcherPages),
    capsuleId: "cap-manual-1" as KnowledgeCapsuleId,
    sourceId: "src-manual-1" as KnowledgeSourceId,
  };
}

describe("createHtmlManualPod", () => {
  it("crawls, parses, chunks, indexes, and represents an approved manual as a ready pod", async () => {
    const result = await createHtmlManualPod(podDeps(MANUAL_PAGES), httpManualSource());

    expect(result.crawl.pages).toHaveLength(3);
    expect(result.indexing?.status).toBe("succeeded");
    expect(result.summary.readiness).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(3);
    expect(result.summary.counts.chunkCount).toBeGreaterThan(0);
    expect(result.summary.counts.vectorCount).toBeGreaterThan(0);
    expect(result.summary.sourceKinds).toStrictEqual(["html-manual-http"]);
    expect(result.summary.manualSourceFingerprint).toBe("fp-docs-internal");
    expect(result.summary.displayName).toBe("Product Handbook");
    expect(readHtmlManualSourceMetadata(store, result.capsuleId, result.sourceId)).toMatchObject({
      sourceKind: "html-manual-http",
      sourceFingerprint: "fp-docs-internal",
      origin: "https://docs.internal",
    });
  });

  it("resolves a manual citation target from persisted approved source metadata", async () => {
    const result = await createHtmlManualPod(podDeps(MANUAL_PAGES), httpManualSource());
    const row = store._internal.db
      .prepare(
        "SELECT id FROM documents WHERE capsule_id = :capsuleId AND source_id = :sourceId AND safe_display_name = 'guide.html'",
      )
      .get({ capsuleId: result.capsuleId, sourceId: result.sourceId }) as
      { readonly id: string } | undefined;
    if (row === undefined) throw new Error("guide document was not indexed");

    const target = resolveHtmlManualCitationTarget(store, {
      capsuleId: result.capsuleId,
      sourceId: result.sourceId,
      documentId: row.id as Parameters<typeof resolveHtmlManualCitationTarget>[1]["documentId"],
      anchorId: "steps",
    });

    expect(target).toMatchObject({
      ok: true,
      sourceKind: "html-manual-http",
      pageTitle: "guide.html",
      relativePath: "guide.html",
    });
    expect(target.ok ? target.target : "").toBe("https://docs.internal/guide.html#steps");
  });

  it("refuses a citation target that escapes the approved manual path prefix", async () => {
    const result = await createHtmlManualPod(podDeps(MANUAL_PAGES), httpManualSource());
    persistHtmlManualSourceMetadata(store, result.capsuleId, result.sourceId, {
      ...httpManualSource(),
      scope: {
        kind: "html-manual-http",
        origin: "https://docs.internal",
        pathPrefix: "/manual",
      },
    });
    const outside = store._internal.db
      .prepare(
        [
          "UPDATE documents SET document_path = :documentPath",
          "WHERE capsule_id = :capsuleId AND source_id = :sourceId",
          "RETURNING id",
        ].join(" "),
      )
      .get({
        capsuleId: result.capsuleId,
        sourceId: result.sourceId,
        documentPath: "keiko-html-manual/cap-manual-1/src-manual-1/manualsibling.html",
      }) as { readonly id: string } | undefined;
    if (outside === undefined) throw new Error("manual document was not indexed");

    expect(
      resolveHtmlManualCitationTarget(store, {
        capsuleId: result.capsuleId,
        sourceId: result.sourceId,
        documentId: outside.id as Parameters<
          typeof resolveHtmlManualCitationTarget
        >[1]["documentId"],
      }),
    ).toStrictEqual({ ok: false, reason: "target-outside-approved-scope" });
  });

  it("redacts an endpoint-bearing proposed pod name to the safe fallback", async () => {
    const result = await createHtmlManualPod(
      podDeps(MANUAL_PAGES),
      httpManualSource("https://docs.internal — HTML manual"),
    );
    expect(result.summary.displayName).toBe("Knowledge Pod");
    expect(JSON.stringify(result.summary)).not.toContain("docs.internal");
  });

  it("does not leak raw page bodies, virtual roots, or private paths into the pod summary", async () => {
    const result = await createHtmlManualPod(podDeps(MANUAL_PAGES), httpManualSource());
    const serialized = JSON.stringify(result.summary);
    expect(serialized).not.toContain("keiko-html-manual");
    expect(serialized).not.toContain("https://docs.internal");
    expect(serialized).not.toContain("content paragraph");
    expect(serialized).not.toContain("<h1>");
    expect(result.summary.privacy.rawContentExposed).toBe(false);
    expect(result.summary.privacy.privatePathsExposed).toBe(false);
  });

  it("creates a degraded pod without indexing when the crawl produces no page", async () => {
    const result = await createHtmlManualPod(podDeps(new Map()), httpManualSource());
    expect(result.crawl.status).toBe("empty");
    expect(result.indexing).toBeUndefined();
    expect(result.summary.counts.documentCount).toBe(0);
    expect(result.summary.readiness).not.toBe("ready");
  });

  it("indexes only link-reachable pages, not every page the fetcher knows", async () => {
    const withOrphan = new Map(MANUAL_PAGES);
    withOrphan.set("https://docs.internal/orphan.html", manualPage("Orphan"));
    const result = await createHtmlManualPod(podDeps(withOrphan), httpManualSource());
    // orphan.html is not linked from any crawled page, so it is never fetched or indexed.
    expect(result.summary.counts.documentCount).toBe(3);
  });

  it("reports a page-limit-truncated crawl as degraded, not ready, even though indexing succeeds", async () => {
    const source = httpManualSource();
    const truncated: HtmlManualSource = {
      ...source,
      limits: { ...source.limits, maxPages: 1 },
    };
    const result = await createHtmlManualPod(podDeps(MANUAL_PAGES), truncated);
    expect(result.crawl.status).toBe("limit-reached");
    expect(result.indexing?.status).toBe("succeeded");
    expect(result.progress.phase).toBe("degraded");
    expect(result.progress.remediations.map((entry) => entry.reason)).toContain("page-limit");
  });

  it("creates the capsule with a caller-supplied sealed policy override, not the standard default, and fails closed on indexing (#1920)", async () => {
    const result = await createHtmlManualPod(
      { ...podDeps(MANUAL_PAGES), modelUsePolicy: sealedLocalPodModelUsePolicy() },
      httpManualSource(),
    );
    expect(result.summary.modelUsePolicy.mode).toBe("sealed-local");
    // The policy override is not just recorded — it actually blocks the embedding preflight
    // (orchestrator.ts `modelUsePolicyPreflightFailure`), so no vector is ever persisted.
    expect(result.indexing?.status).toBe("failed");
    expect(result.indexing?.lastError).toMatchObject({ code: "POLICY_DENIED" });
    expect(result.progress.phase).toBe("degraded");
    expect(result.progress.remediations.map((entry) => entry.reason)).toContain("POLICY_DENIED");
    expect(result.summary.counts.vectorCount).toBe(0);
  });

  it("reports a real embedding-adapter failure as a degraded pod with remediation guidance", async () => {
    const deps = podDeps(MANUAL_PAGES);
    const failingAdapter: typeof deps.embeddingAdapter = {
      ...deps.embeddingAdapter,
      request: (): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({ ok: false, kind: "transport" }),
    };
    const result = await createHtmlManualPod(
      { ...deps, embeddingAdapter: failingAdapter },
      httpManualSource(),
    );
    expect(result.crawl.status).toBe("completed");
    // A universally failing adapter aborts during the embedding-space preflight, before any
    // document is processed — the job fails closed at the job level rather than accumulating
    // per-document failures.
    expect(result.indexing?.status).toBe("failed");
    expect(result.progress.phase).toBe("degraded");
    expect(result.progress.remediations.map((entry) => entry.reason)).toContain(
      "EMBEDDING_ADAPTER_FAILED",
    );
  });

  it("does not publish a ready pod when the crawl is cancelled (#1875)", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createHtmlManualPod(
      { ...podDeps(MANUAL_PAGES), signal: controller.signal },
      httpManualSource(),
    );
    expect(result.crawl.status).toBe("cancelled");
    expect(result.indexing).toBeUndefined();
    expect(result.summary.readiness).not.toBe("ready");
    expect(result.summary.counts.vectorCount).toBe(0);
    expect(result.progress.phase).toBe("cancelled");
  });
});
