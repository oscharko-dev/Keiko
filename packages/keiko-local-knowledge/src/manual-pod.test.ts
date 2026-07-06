import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import { createInMemoryManualFetcher, type InMemoryManualPage } from "./crawl/index.js";
import { createHtmlManualPod, type CreateHtmlManualPodDeps } from "./manual-pod.js";
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
    expect(result.summary.sourceKinds).toContain("files");
    expect(result.summary.displayName).toBe("Product Handbook");
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
