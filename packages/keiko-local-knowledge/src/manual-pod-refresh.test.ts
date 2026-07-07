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
import { listPersistedDocumentsForSource } from "./discovery/persist.js";
import { createHtmlManualPod, type CreateHtmlManualPodDeps } from "./manual-pod.js";
import { refreshHtmlManualPod, type RefreshHtmlManualPodDeps } from "./manual-pod-refresh.js";
import { readManualPageFingerprints } from "./manual-page-fingerprints.js";
import { readHtmlManualSourceMetadata } from "./manual-source-metadata.js";
import { countVectorsForDocument } from "./indexing/vector-persist.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import { addSourceToCapsule, updateSourceScopeInCapsule } from "./source-lifecycle.js";
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

  it("fails closed when the refresh indexing run itself fails: prior documents are kept, but the whole capsule's readiness flips to error", async () => {
    // Regression for #1894 finding "refresh-indexing-failure-degrades-capsule-readiness-untested":
    // no test previously injected a failing embeddingAdapter into a real refreshHtmlManualPod run,
    // so this path (crawl succeeds, indexing fails) had zero end-to-end coverage anywhere. `runIndexingJob`
    // is invoked with `sourceIds: [SOURCE_ID]`, but its generic `finalize()` (indexing/orchestrator.ts)
    // still calls `updateCapsuleState(store, capsule.id, "error")` for the WHOLE capsule, unconditionally,
    // on any indexing failure — not just this source. This test pins that CURRENT behaviour so a future
    // change to it is a deliberate, reviewed decision rather than a silent regression either way. Whether
    // a capsule-wide readiness downgrade is the right signal for a single-source refresh failure in a
    // multi-source capsule is a production-code question (indexing/orchestrator.ts `finalize`), out of
    // this test-file-only scope.
    await createBasePod();
    const failingAdapter = scriptedAdapter({
      identity: DEFAULT_EMBEDDING,
      responder: () => ({ ok: false, kind: "transport" }),
    });

    const result = await refreshHtmlManualPod(
      refreshDeps(baseManual(), { embeddingAdapter: failingAdapter }),
    );

    // The crawl itself is unaffected by the embedding adapter — only indexing fails.
    expect(result.crawl.status).toBe("completed");
    expect(result.indexing?.status).toBe("failed");
    expect(result.changeSummary.outcome).toBe("failed");
    expect(result.changeSummary.reasonCodes).toContain("index-failed");
    // No page-level failures are attributed — the adapter failed the embedding preflight before any
    // document was processed, distinct from a partial per-document failure.
    expect(result.changeSummary.counts.failedPages).toBe(0);
    // The prior 3-page pod's data is preserved — a failed refresh never wipes or overwrites it.
    expect(result.summary.counts.documentCount).toBe(3);
    // Documented current behaviour: capsule-wide readiness is downgraded to "error" even though this
    // was a single-source refresh and the underlying documents were left untouched.
    expect(result.summary.readiness).toBe("error");
  });

  it("does not advance the fingerprint baseline for a page whose re-embed fails, even when another page in the same refresh succeeds", async () => {
    // Regression for #1894 finding "refresh-indexing-failure-destroys-prior-good-state": a
    // per-document embedding failure during refresh deletes that document's existing vectors before
    // the re-embed is attempted (indexing/orchestrator.ts `applyIncrementalFastPath`), and
    // `IndexingResult.status` only reports "failed" when EVERY document in the run failed — so a run
    // where another page succeeds still reports "succeeded", masking the failure. Left unguarded,
    // `applyRefresh` would advance the persisted fingerprint baseline for the failed page's NEW
    // content anyway, so a later refresh would see it as "unchanged" and never retry re-embedding it —
    // permanently hiding a page that lost its vectors behind an apparently caught-up, healthy refresh.
    await createBasePod();
    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide ZZZMARKERZZZ Revision", ["/"]));
    mutated.set(REFERENCE, manualPage("Reference Revised"));

    const failingAdapter = scriptedAdapter({
      identity: DEFAULT_EMBEDDING,
      responder: (request) =>
        request.input.includes("ZZZMARKERZZZ")
          ? { ok: false, kind: "unsupported-model" }
          : {
              ok: true,
              value: {
                vector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(0.1),
                modelId: DEFAULT_EMBEDDING.modelId,
              },
            },
    });

    const result = await refreshHtmlManualPod(
      refreshDeps(mutated, { embeddingAdapter: failingAdapter }),
    );

    // The masking case: Reference's re-embed processed cleanly, so the overall job status is
    // "succeeded" even though Guide's re-embed failed.
    expect(result.indexing?.status).toBe("succeeded");
    expect(result.indexing?.failedDocuments).toBeGreaterThan(0);
    expect(result.changeSummary.outcome).toBe("partial");
    expect(result.changeSummary.counts.failedPages).toBeGreaterThan(0);

    // The regression: guide.html's fingerprint baseline must NOT be advanced to the new (failed,
    // unindexed) content -- otherwise a later refresh would treat it as already caught up.
    const fingerprints = readManualPageFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.has("guide.html")).toBe(false);
    // Reference's own successful re-embed still commits its baseline normally.
    expect(fingerprints.has("reference.html")).toBe(true);

    // Prove it actually gets retried: refreshing again with a fully working adapter re-embeds
    // guide.html rather than silently treating it as already caught up.
    const retry = await refreshHtmlManualPod(refreshDeps(mutated));
    expect(retry.indexing?.status).toBe("succeeded");
    expect(retry.indexing?.failedDocuments).toBe(0);
    expect(retry.changeSummary.outcome).not.toBe("unchanged");
    const fingerprintsAfterRetry = readManualPageFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprintsAfterRetry.has("guide.html")).toBe(true);
  });

  it("does not prune a page that disappeared upstream when another page in the same refresh fails to re-embed", async () => {
    // Regression for the post-merge epic-integration finding
    // "refresh-partial-failure-destroys-content-behind-misleading-guidance" (compound-failure half):
    // indexing/orchestrator.ts's finalizeSourceRun previously pruned documents no longer in the new
    // crawl's page set unconditionally, even when another document in the same run failed to
    // re-embed. Reference genuinely disappears upstream while Guide fails to re-embed in the same
    // refresh; Reference's document must survive since this run's discovered-path set cannot be
    // trusted as a complete picture of the source when part of the run failed.
    await createBasePod();
    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide ZZZMARKERZZZ Revision", ["/"]));
    mutated.delete(REFERENCE);

    const failingAdapter = scriptedAdapter({
      identity: DEFAULT_EMBEDDING,
      responder: (request) =>
        request.input.includes("ZZZMARKERZZZ")
          ? { ok: false, kind: "unsupported-model" }
          : {
              ok: true,
              value: {
                vector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(0.1),
                modelId: DEFAULT_EMBEDDING.modelId,
              },
            },
    });

    const result = await refreshHtmlManualPod(
      refreshDeps(mutated, { embeddingAdapter: failingAdapter }),
    );
    expect(result.indexing?.failedDocuments).toBeGreaterThan(0);

    const documents = listPersistedDocumentsForSource(store._internal.db, CAPSULE_ID, SOURCE_ID);
    const referenceDoc = documents.find((doc) => doc.document_path.includes("reference"));
    expect(referenceDoc).toBeDefined();
  });

  it("characterizes the known gap: a changed page's vectors are not rolled back when its own re-embed fails", async () => {
    // Documents a still-open architectural gap (see docs/local-knowledge/html-manual-refresh-
    // lifecycle-ledger.md "Known gap: an indexing-phase failure/partial does not roll back a
    // changed page's vectors"). Guide's previously-good vectors are deleted as part of the
    // incremental fast-path/chunk-replace before its re-embed is attempted; when that re-embed
    // fails, the page ends up with zero vectors rather than its previous (good) ones, for the
    // window until a future successful refresh repairs it (proven not-permanent by the fingerprint-
    // baseline test above). This is a shared indexing-orchestrator behaviour, not specific to HTML
    // manual refresh -- fixing it requires an "embed-then-swap" staging change to
    // packages/keiko-local-knowledge/src/indexing/orchestrator.ts's chunk/embed pipeline, used by
    // every indexing job in the product, which is out of scope for this change and requires its own
    // design/review. This test pins CURRENT behaviour so a future fix must consciously update it
    // (flip the final assertion) rather than silently regress back to it.
    await createBasePod();
    const before = listPersistedDocumentsForSource(store._internal.db, CAPSULE_ID, SOURCE_ID);
    const guideDocBefore = before.find((doc) => doc.document_path.includes("guide"));
    if (guideDocBefore === undefined) throw new Error("guide document was not indexed");
    const vectorsBefore = countVectorsForDocument(
      store._internal.db,
      CAPSULE_ID,
      guideDocBefore.id,
    );
    expect(vectorsBefore).toBeGreaterThan(0);

    const mutated = baseManual();
    mutated.set(GUIDE, manualPage("Guide ZZZMARKERZZZ Revision", ["/"]));
    const failingAdapter = scriptedAdapter({
      identity: DEFAULT_EMBEDDING,
      responder: (request) =>
        request.input.includes("ZZZMARKERZZZ")
          ? { ok: false, kind: "unsupported-model" }
          : {
              ok: true,
              value: {
                vector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(0.1),
                modelId: DEFAULT_EMBEDDING.modelId,
              },
            },
    });

    await refreshHtmlManualPod(refreshDeps(mutated, { embeddingAdapter: failingAdapter }));

    const after = listPersistedDocumentsForSource(store._internal.db, CAPSULE_ID, SOURCE_ID);
    const guideDocAfter = after.find((doc) => doc.document_path.includes("guide"));
    if (guideDocAfter === undefined) throw new Error("guide document was not indexed");
    const vectorsAfter = countVectorsForDocument(store._internal.db, CAPSULE_ID, guideDocAfter.id);
    // KNOWN GAP (tracked, not silently regressed): today this is 0, not >0. When the shared
    // orchestrator gains embed-then-swap staging, this assertion should become
    // `expect(vectorsAfter).toBeGreaterThan(0)` and the surrounding comment/ledger entry updated.
    expect(vectorsAfter).toBe(0);
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

  // Regression for #1894 finding "resolve-refresh-source-guards-partially-tested": the test above only
  // exercises the `metadata === undefined` guard. `resolveRefreshSource` / `reconstructHtmlManualSource`
  // (manual-pod-refresh.ts) have three independent fail-closed throw sites; the two below were previously
  // exercised by no test anywhere in the file.

  it("throws when persisted manual metadata exists but the attached source scope is no longer a crawled HTML manual", async () => {
    await createBasePod();
    // Simulate a stale/orphaned metadata row: the html_manual_sources row for (capsuleId, sourceId) is
    // still present, but the attached KnowledgeSource itself has since been rebound to a non-"files"
    // scope (e.g. a future code path that persists metadata before attaching the files-scoped source).
    updateSourceScopeInCapsule(store, CAPSULE_ID, SOURCE_ID, {
      kind: "folder",
      rootPath: "/srv/docs",
      recursive: true,
    });

    await expect(refreshHtmlManualPod(refreshDeps(baseManual()))).rejects.toThrow(
      /manual source is not a crawled HTML manual/u,
    );
  });

  it("throws when the persisted manual scope is incomplete (legacy row missing its origin)", async () => {
    await createBasePod();
    // Simulate a corrupted/legacy persisted row that reconstructScope cannot turn into a crawl scope.
    store._internal.db
      .prepare(
        "UPDATE html_manual_sources SET origin = NULL WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });

    await expect(refreshHtmlManualPod(refreshDeps(baseManual()))).rejects.toThrow(
      /persisted manual scope is incomplete/u,
    );
  });

  it("throws when the persisted manual source fails re-validation", async () => {
    await createBasePod();
    // A reconstructible scope that nonetheless fails validateHtmlManualSource (empty fingerprint).
    store._internal.db
      .prepare(
        "UPDATE html_manual_sources SET source_fingerprint = '' WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });

    await expect(refreshHtmlManualPod(refreshDeps(baseManual()))).rejects.toThrow(
      /persisted manual source is invalid/u,
    );
  });
});
