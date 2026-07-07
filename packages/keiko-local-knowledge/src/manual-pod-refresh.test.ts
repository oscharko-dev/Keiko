// Refresh regression suite for HTML Manual Knowledge Pods (Epic #1856, Issues #1891/#1892/#1894).
//
// Every test creates a real pod through `createHtmlManualPod`, then runs `refreshHtmlManualPod`
// against a mutated in-memory crawl to prove: scope preservation (no widening), added/changed/
// removed/unchanged classification, fail-closed behaviour on limits/cancellation/empty crawls, and
// that no raw content/path/origin ever leaks into the change summary or pod summary. It reuses the
// first-crawl fixtures + fetcher rather than re-testing crawl primitives.

import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  validateManualRefreshChangeSummary,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "./capsule-lifecycle.js";
import { createInMemoryManualFetcher, type InMemoryManualPage } from "./crawl/index.js";
import { createHtmlManualPod, type CreateHtmlManualPodDeps } from "./manual-pod.js";
import { refreshHtmlManualPod, type RefreshHtmlManualPodDeps } from "./manual-pod-refresh.js";
import { readManualPageFingerprints } from "./manual-page-fingerprints.js";
import { readHtmlManualSourceMetadata } from "./manual-source-metadata.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "./_support.js";
import type { KnowledgeStore } from "./store.js";
import { scriptedAdapter } from "./testing.js";

const CAPSULE_ID = "cap-manual-1" as KnowledgeCapsuleId;
const SOURCE_ID = "src-manual-1" as KnowledgeSourceId;

const HOME = "https://docs.internal/";
const GUIDE = "https://docs.internal/guide.html";
const REFERENCE = "https://docs.internal/reference.html";
const EXTRA = "https://docs.internal/extra.html";

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

function baseManual(): Map<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    [HOME, manualPage("Home", ["guide.html", "reference.html"])],
    [GUIDE, manualPage("Guide", ["/"])],
    [REFERENCE, manualPage("Reference")],
  ]);
}

function source(overrides: Partial<HtmlManualSource> = {}): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://docs.internal", pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-docs-internal",
    proposedPodName: "Product Handbook",
    ...overrides,
  };
}

function createDeps(pages: Map<string, InMemoryManualPage>): CreateHtmlManualPodDeps {
  return {
    store,
    parserRegistry: createDefaultParserRegistry(),
    embeddingAdapter: scriptedAdapter({ identity: DEFAULT_EMBEDDING }),
    embeddingModelIdentity: DEFAULT_EMBEDDING,
    fetcher: createInMemoryManualFetcher(pages),
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
  };
}

function refreshDeps(
  pages: Map<string, InMemoryManualPage>,
  overrides: Partial<RefreshHtmlManualPodDeps> = {},
): RefreshHtmlManualPodDeps {
  return {
    store,
    parserRegistry: createDefaultParserRegistry(),
    embeddingAdapter: scriptedAdapter({ identity: DEFAULT_EMBEDDING }),
    fetcher: createInMemoryManualFetcher(pages),
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
    ...overrides,
  };
}

async function createBasePod(
  pages: Map<string, InMemoryManualPage> = baseManual(),
  src: HtmlManualSource = source(),
): Promise<void> {
  const result = await createHtmlManualPod(createDeps(pages), src);
  expect(result.summary.counts.documentCount).toBeGreaterThan(0);
}

describe("refreshHtmlManualPod", () => {
  it("reports an unchanged manual as unchanged and preserves the ready pod", async () => {
    await createBasePod();
    const result = await refreshHtmlManualPod(refreshDeps(baseManual()));

    expect(result.changeSummary.outcome).toBe("unchanged");
    expect(result.changeSummary.counts.unchangedPages).toBe(3);
    expect(result.changeSummary.counts.addedPages).toBe(0);
    expect(result.changeSummary.counts.changedPages).toBe(0);
    expect(result.changeSummary.counts.removedPages).toBe(0);
    expect(result.changeSummary.reasonCodes).toStrictEqual(["scope-preserved"]);
    expect(result.summary.readiness).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(3);
    expect(validateManualRefreshChangeSummary(result.changeSummary).ok).toBe(true);
  });

  it("classifies a changed page and re-indexes it", async () => {
    await createBasePod();
    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide Revised Second Edition", ["/"]));

    const result = await refreshHtmlManualPod(refreshDeps(mutated));

    expect(result.changeSummary.counts.changedPages).toBe(1);
    expect(result.changeSummary.counts.addedPages).toBe(0);
    expect(result.changeSummary.counts.removedPages).toBe(0);
    expect(result.changeSummary.outcome).toBe("updated");
    expect(result.changeSummary.reasonCodes).toContain("pages-changed");
    expect(result.summary.counts.documentCount).toBe(3);
    // The redacted change summary is surfaced through the pod summary for UI diagnostics (#1893).
    expect(result.summary.manualRefresh?.outcome).toBe("updated");
    expect(result.summary.manualRefresh?.counts.changedPages).toBe(1);
  });

  it("classifies a newly reachable page as added", async () => {
    // Home already links extra.html, but extra.html only becomes reachable at refresh time — so the
    // home page bytes are unchanged and only the new page is added.
    const withDanglingLink = baseManual();
    withDanglingLink.set(HOME, manualPage("Home", ["guide.html", "reference.html", "extra.html"]));
    await createBasePod(withDanglingLink);

    const withExtra = new Map(withDanglingLink);
    withExtra.set(EXTRA, manualPage("Extra"));
    const result = await refreshHtmlManualPod(refreshDeps(withExtra));

    expect(result.changeSummary.counts.addedPages).toBe(1);
    expect(result.changeSummary.counts.changedPages).toBe(0);
    expect(result.changeSummary.outcome).toBe("updated");
    expect(result.changeSummary.reasonCodes).toContain("pages-added");
    expect(result.summary.counts.documentCount).toBe(4);
  });

  it("classifies and prunes a page that is no longer reachable", async () => {
    await createBasePod();
    // reference.html disappears from the origin; home still links it, so it becomes fetch-failed and
    // drops out of the crawl. Removal detection is valid because the crawl still completed.
    const withoutReference = baseManual();
    withoutReference.delete(REFERENCE);

    const result = await refreshHtmlManualPod(refreshDeps(withoutReference));

    expect(result.changeSummary.counts.removedPages).toBe(1);
    expect(result.changeSummary.removalDetection).toBe("evaluated");
    expect(result.changeSummary.outcome).toBe("updated");
    expect(result.changeSummary.reasonCodes).toContain("pages-removed");
    // The pruned page is gone from the index and its fingerprint baseline.
    expect(result.summary.counts.documentCount).toBe(2);
    const fingerprints = readManualPageFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.has("reference.html")).toBe(false);
  });

  it("fails closed on a limit-reached crawl, leaving the previous pod untouched", async () => {
    // Persisted approved limit is maxPages=1, so both the create and the refresh crawls truncate.
    await createBasePod(baseManual(), source({ limits: { ...source().limits, maxPages: 1 } }));
    const before = readHtmlManualSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(before?.limits?.maxPages).toBe(1);

    const result = await refreshHtmlManualPod(refreshDeps(baseManual()));

    expect(result.crawl.status).toBe("limit-reached");
    expect(result.indexing).toBeUndefined();
    expect(result.changeSummary.outcome).toBe("partial");
    expect(result.changeSummary.removalDetection).toBe("not-evaluated-page-limit");
    expect(result.changeSummary.reasonCodes).toContain("scope-limit-reached");
    expect(result.changeSummary.counts.removedPages).toBe(0);
    // The prior single-page pod is left fully intact (no scope mutation, no pruning).
    expect(result.summary.counts.documentCount).toBe(1);
  });

  it("does not widen scope: cross-origin links are denied even when the fetcher serves them", async () => {
    await createBasePod();
    const hostile = baseManual();
    hostile.set(
      HOME,
      manualPage("Home", ["guide.html", "reference.html", "https://evil.example/x"]),
    );
    hostile.set("https://evil.example/x", manualPage("Evil"));

    const result = await refreshHtmlManualPod(refreshDeps(hostile));

    expect(result.changeSummary.counts.deniedLinks).toBeGreaterThan(0);
    expect(result.changeSummary.reasonCodes).toContain("links-denied");
    expect(result.changeSummary.reasonCodes).toContain("scope-preserved");
    // The evil origin was never crawled or indexed.
    const fingerprints = readManualPageFingerprints(store, CAPSULE_ID, SOURCE_ID);
    for (const path of fingerprints.keys()) {
      expect(path).not.toContain("evil.example");
    }
  });

  it("leaves the previous pod usable when the crawl is cancelled", async () => {
    await createBasePod();
    const controller = new AbortController();
    controller.abort();

    const result = await refreshHtmlManualPod(
      refreshDeps(baseManual(), { signal: controller.signal }),
    );

    expect(result.crawl.status).toBe("cancelled");
    expect(result.indexing).toBeUndefined();
    expect(result.changeSummary.outcome).toBe("cancelled");
    expect(result.summary.counts.documentCount).toBe(3);
  });

  it("leaves the previous pod usable when the refresh crawl is empty", async () => {
    await createBasePod();
    const result = await refreshHtmlManualPod(refreshDeps(new Map()));

    expect(result.crawl.status).toBe("empty");
    expect(result.changeSummary.outcome).toBe("failed");
    expect(result.changeSummary.reasonCodes).toContain("crawl-empty");
    // The prior 3-page pod is preserved rather than wiped to empty.
    expect(result.summary.counts.documentCount).toBe(3);
  });

  it("persists the redacted change summary and crawl-run id for later diagnostics", async () => {
    await createBasePod();
    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide Rewritten", ["/"]));
    await refreshHtmlManualPod(refreshDeps(mutated));

    const metadata = readHtmlManualSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(metadata?.lastRefreshedAt).toBeGreaterThan(0);
    expect(metadata?.lastCrawlRunId).toBeTruthy();
    const persisted = JSON.parse(metadata?.lastChangeSummaryJson ?? "{}") as unknown;
    expect(validateManualRefreshChangeSummary(persisted).ok).toBe(true);
  });

  it("does not leak raw content, private paths, or the origin into refresh diagnostics", async () => {
    await createBasePod();
    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide Confidential Revision", ["/"]));
    const result = await refreshHtmlManualPod(refreshDeps(mutated));

    for (const serialized of [
      JSON.stringify(result.changeSummary),
      JSON.stringify(result.summary),
      JSON.stringify(result.progress),
    ]) {
      expect(serialized).not.toContain("keiko-html-manual");
      expect(serialized).not.toContain("https://docs.internal");
      expect(serialized).not.toContain("content paragraph");
      expect(serialized).not.toContain("Confidential");
    }
  });

  it("throws for a source that is not an approved HTML manual", async () => {
    const other = "cap-folder-1" as KnowledgeCapsuleId;
    const folderSource = "src-folder-1" as KnowledgeSourceId;
    createCapsule(
      store,
      sampleCapsuleInput({ id: other, embeddingModelIdentity: DEFAULT_EMBEDDING }),
    );
    addSourceToCapsule(store, other, {
      id: folderSource,
      displayName: "Folder",
      tags: [],
      scope: { kind: "folder", rootPath: "/srv/docs", recursive: true },
    });

    await expect(
      refreshHtmlManualPod(refreshDeps(baseManual(), { capsuleId: other, sourceId: folderSource })),
    ).rejects.toThrow(/no approved HTML manual source/u);
  });
});
