import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type HtmlManualCrawlScope,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import { createDefaultParserRegistry } from "../parsers/index.js";
import type { KnowledgeStore } from "../store.js";
import { scriptedAdapter } from "../testing.js";
import { createHtmlManualPod } from "../manual-pod.js";
import { crawlManual } from "./crawl-runner.js";
import { createInMemoryManualFetcher } from "./fetchers.js";
import {
  framesetManualFixture,
  hostileLinkFixture,
  legacyManualFixture,
  localLegacyManualFixture,
  malformedManualFixture,
  MANUAL_FIXTURE_ORIGIN,
} from "./manual-fixtures.js";
import type { ManualCrawlDenyReason } from "./types.js";

const HTTP_SCOPE: HtmlManualCrawlScope = {
  kind: "html-manual-http",
  origin: MANUAL_FIXTURE_ORIGIN,
  pathPrefix: null,
};

function httpSource(scope: HtmlManualCrawlScope = HTTP_SCOPE): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope,
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-fixture",
    proposedPodName: "Product Handbook",
  };
}

function deniedReasons(denied: readonly { readonly reason: ManualCrawlDenyReason }[]): Set<string> {
  return new Set(denied.map((entry) => entry.reason));
}

describe("static HTML manual crawl regression (#1876)", () => {
  it("crawls a realistic legacy manual and deduplicates repeat and anchor links", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(legacyManualFixture()) },
      httpSource(),
    );
    expect(result.pages.map((page) => page.relativePath)).toEqual([
      "index.html",
      "chapters/install.html",
      "chapters/config.html",
      "reference/api.html",
    ]);
    expect(result.status).toBe("completed");
    // reference/api.html links back to "../index.html" — a same-page link that must dedup against
    // the "/" seed via a normalised canonical key, not spuriously re-fetch and fail (#1877).
    expect(result.denied).toEqual([]);
  });

  it("follows frameset and iframe references in a legacy framed manual", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(framesetManualFixture()) },
      httpSource(),
    );
    expect(result.pages.map((page) => page.relativePath).sort()).toEqual([
      "content/body.html",
      "content/toc.html",
      "index.html",
    ]);
  });

  it("accepts only in-scope pages from a hostile index and refuses every denied class", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(hostileLinkFixture()) },
      httpSource(),
    );
    expect(result.pages.map((page) => page.relativePath).sort()).toEqual([
      "index.html",
      "page.html",
      "safe.html",
    ]);
    const reasons = deniedReasons(result.denied);
    expect(reasons).toContain("cross-origin");
    expect(reasons).toContain("credentialed-url");
    expect(reasons).toContain("action-link");
    expect(reasons).toContain("unsupported-scheme");
    expect(reasons).toContain("non-html");
  });

  it("never leaks a raw denied target, query token, or credential into the crawl result", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(hostileLinkFixture()) },
      httpSource(),
    );
    const serialized = JSON.stringify(result.denied) + JSON.stringify(result.stats);
    expect(serialized).not.toContain("evil.example");
    expect(serialized).not.toContain("abc123token");
    expect(serialized).not.toContain("user:pass");
  });

  it("tolerates malformed HTML without throwing and still finds recoverable links", async () => {
    const result = await crawlManual(
      { fetcher: createInMemoryManualFetcher(malformedManualFixture()) },
      httpSource(),
    );
    expect(result.pages.map((page) => page.relativePath)).toContain("ok.html");
    expect(result.status).toBe("completed");
  });
});

describe("static HTML manual full pipeline regression (#1876)", () => {
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

  it("turns the legacy http manual into a ready pod with leakage-free evidence", async () => {
    const result = await createHtmlManualPod(
      {
        store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: scriptedAdapter({ identity: DEFAULT_EMBEDDING }),
        embeddingModelIdentity: DEFAULT_EMBEDDING,
        fetcher: createInMemoryManualFetcher(legacyManualFixture()),
        capsuleId: "cap-legacy" as KnowledgeCapsuleId,
        sourceId: "src-legacy" as KnowledgeSourceId,
      },
      httpSource(),
    );
    expect(result.summary.readiness).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(4);
    expect(result.summary.counts.vectorCount).toBeGreaterThan(0);
    const serialized = JSON.stringify(result.summary);
    expect(serialized).not.toContain("manual.test");
    expect(serialized).not.toContain("keiko-html-manual");
    expect(serialized).not.toMatch(/<[a-z]/u);
  });

  it("turns a local legacy manual into a ready pod through the same pipeline", async () => {
    const localScope: HtmlManualCrawlScope = {
      kind: "html-manual-local",
      rootPath: "manuals/handbook",
      entryPath: "index.html",
    };
    const result = await createHtmlManualPod(
      {
        store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: scriptedAdapter({ identity: DEFAULT_EMBEDDING }),
        embeddingModelIdentity: DEFAULT_EMBEDDING,
        fetcher: createInMemoryManualFetcher(localLegacyManualFixture()),
        capsuleId: "cap-local" as KnowledgeCapsuleId,
        sourceId: "src-local" as KnowledgeSourceId,
      },
      httpSource(localScope),
    );
    expect(result.summary.readiness).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(4);
  });
});
