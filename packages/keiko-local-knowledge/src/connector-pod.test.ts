// Connector-backed Knowledge Pod sink tests (Issue #2242, Epic #2238, ADR-0128 D5).
//
// Hermetic and network-free: items arrive as normalized content (the shape the sync lane hands
// over), the parser registry and chunker are REAL, the embedding adapter is deterministic, and
// the store is a fresh temp SQLite file. Proves the sink end to end: create shell → apply →
// retrieval with page-title citations and provider click-through links → re-sync diff with
// indexing-call-count evidence → removals leave the index → degradation and redaction.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import {
  applyConnectorSyncRun,
  createConnectorPodShell,
  recordUnappliedConnectorSyncRun,
  type ConnectorPodIndexingDeps,
  type ConnectorSyncContentItem,
} from "./connector-pod.js";
import { readConnectorItemFingerprints } from "./connector-item-fingerprints.js";
import {
  readConnectorSourceMetadata,
  resolveConnectorCitationTarget,
} from "./connector-source-metadata.js";
import { buildKnowledgePodSummary } from "./knowledge-pods.js";
import { getCapsule } from "./capsule-lifecycle.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import { runLocalKnowledgeRetrieval } from "./retrieval/index.js";
import { scriptedAdapter } from "./testing.js";
import type { KnowledgeStore } from "./store.js";

const CAPSULE_ID = "cap-connector" as KnowledgeCapsuleId;
const SOURCE_ID = "src-connector" as KnowledgeSourceId;
const CONNECTOR_ID = "cred-abc123";
const BASE_URL = "https://tenant.example";

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

const CONSTANT_VECTOR = new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(1);

interface CountingAdapter {
  readonly adapter: ReturnType<typeof scriptedAdapter>;
  readonly calls: () => number;
}

function countingAdapter(): CountingAdapter {
  let calls = 0;
  const adapter = scriptedAdapter({
    identity: DEFAULT_EMBEDDING,
    responder: (): OpenAIEmbeddingOutcome => {
      calls += 1;
      return { ok: true, value: { vector: CONSTANT_VECTOR, modelId: DEFAULT_EMBEDDING.modelId } };
    },
  });
  return { adapter, calls: () => calls };
}

function pageItem(
  id: number,
  body: string,
  overrides: Partial<ConnectorSyncContentItem> = {},
): ConnectorSyncContentItem {
  const title = overrides.title ?? `Page ${String(id)}`;
  const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return {
    itemKey: `confluence:${CONNECTOR_ID}:${String(id)}`,
    relativePath: `pages/${String(id)}.html`,
    title,
    bytes: new TextEncoder().encode(html),
    webuiPath: `/wiki/spaces/ENG/pages/${String(id)}`,
    ...overrides,
  };
}

function createShell(): void {
  createConnectorPodShell(
    { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
    {
      definition: {
        provider: "confluence",
        connectorId: CONNECTOR_ID,
        baseUrl: BASE_URL,
        scopeKeys: ["ENG"],
        bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
      },
      displayName: "Engineering Wiki",
      embeddingModelIdentity: DEFAULT_EMBEDDING,
    },
  );
}

function indexingDeps(adapter: CountingAdapter): ConnectorPodIndexingDeps {
  return {
    store,
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
    parserRegistry: createDefaultParserRegistry(),
    embeddingAdapter: adapter.adapter,
  };
}

function keysOf(items: readonly ConnectorSyncContentItem[]): readonly string[] {
  return items.map((item) => item.itemKey);
}

describe("createConnectorPodShell", () => {
  it("creates a draft pod that already projects its approved connector scope", () => {
    createShell();
    const capsule = getCapsule(store, CAPSULE_ID);
    expect(capsule?.lifecycleState).toBe("draft");
    if (capsule === undefined) throw new Error("capsule missing");
    const summary = buildKnowledgePodSummary(store, capsule);
    expect(summary.readiness).toBe("draft");
    expect(summary.connectorSource).toEqual({
      provider: "confluence",
      connectorId: CONNECTOR_ID,
      scopeLabels: ["ENG"],
    });
  });
});

describe("applyConnectorSyncRun — initial sync", () => {
  it("indexes items through the shared pipeline, retitles documents, persists fingerprints, and reports added counts", async () => {
    createShell();
    const adapter = countingAdapter();
    const items = [
      pageItem(1, "The deployment pipeline runs on merge.", { title: "Deployment Guide" }),
      pageItem(2, "Rotate credentials quarterly."),
      pageItem(3, "Escalation goes to the on-call channel."),
    ];
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    expect(result.changeSummary.outcome).toBe("succeeded");
    expect(result.changeSummary.counts).toEqual({
      addedItems: 3,
      changedItems: 0,
      removedItems: 0,
      unchangedItems: 0,
      failedItems: 0,
      deniedItems: 0,
    });
    expect(result.changeSummary.fingerprintSetDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.summary.readiness).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(3);
    expect(result.summary.connectorSource?.lastChangeSummary?.outcome).toBe("succeeded");
    expect(adapter.calls()).toBeGreaterThan(0);
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.size).toBe(3);

    // Retrieval flows through the ONE shared path with page-title citations.
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "How does the deployment pipeline run?", capsuleId: CAPSULE_ID, topK: 3 },
    );
    expect(retrieval.noEvidence).toBe(false);
    const titles = retrieval.references.map((ref) => ref.citation.safeDisplayName);
    expect(titles).toContain("Deployment Guide");

    // Citation click-through resolves to the provider webui link on the approved base URL.
    const reference = retrieval.references.find(
      (ref) => ref.citation.safeDisplayName === "Deployment Guide",
    );
    expect(reference).toBeDefined();
    const target = resolveConnectorCitationTarget(store, {
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
      documentId: reference?.citation.documentId ?? ("" as DocumentId),
    });
    expect(target).toMatchObject({
      ok: true,
      target: "https://tenant.example/wiki/spaces/ENG/pages/1",
      pageTitle: "Deployment Guide",
      itemKey: `confluence:${CONNECTOR_ID}:1`,
    });
  });

  it("reports partial with exact denied/failed counts while still indexing the healthy items", async () => {
    createShell();
    const adapter = countingAdapter();
    const items = [pageItem(1, "alpha"), pageItem(2, "beta")];
    const deniedKey = `confluence:${CONNECTOR_ID}:3`;
    const failedKey = `confluence:${CONNECTOR_ID}:4`;
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: [...keysOf(items), deniedKey, failedKey],
      deniedItemKeys: [deniedKey],
      failedItemKeys: [failedKey],
    });
    expect(result.changeSummary.outcome).toBe("partial");
    expect(result.changeSummary.counts).toMatchObject({
      addedItems: 2,
      removedItems: 0,
      failedItems: 1,
      deniedItems: 1,
    });
    // Denied/failed items keep NO baseline entry, so the next run retries them.
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect([...fingerprints.keys()].sort()).toEqual([...keysOf(items)].sort());
    // A partial sync degrades the pod without hiding the content that did index.
    expect(result.summary.readiness).toBe("degraded");
    expect(result.summary.counts.documentCount).toBe(2);
    const metadata = readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(metadata?.lastSyncStatus).toBe("partial");
  });
});

describe("applyConnectorSyncRun — explicit re-sync", () => {
  async function initialSync(
    adapter: CountingAdapter,
  ): Promise<readonly ConnectorSyncContentItem[]> {
    const items = [
      pageItem(1, "Original content one."),
      pageItem(2, "Original content two."),
      pageItem(3, "Original content three."),
      pageItem(4, "Original content four."),
    ];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-initial",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    return items;
  }

  it("re-syncing identical content re-indexes NOTHING (embedding calls stay at the per-job probe cost)", async () => {
    createShell();
    const adapter = countingAdapter();
    const items = await initialSync(adapter);
    const callsAfterInitial = adapter.calls();
    const runIdentical = async (
      runId: string,
    ): Promise<Awaited<ReturnType<typeof applyConnectorSyncRun>>> =>
      applyConnectorSyncRun(indexingDeps(adapter), {
        runId,
        items,
        enumeratedItemKeys: keysOf(items),
        deniedItemKeys: [],
        failedItemKeys: [],
      });
    const first = await runIdentical("run-identical-1");
    const probeCost = adapter.calls() - callsAfterInitial;
    const second = await runIdentical("run-identical-2");
    for (const result of [first, second]) {
      expect(result.changeSummary.counts).toMatchObject({
        addedItems: 0,
        changedItems: 0,
        removedItems: 0,
        unchangedItems: 4,
      });
      expect(result.indexing?.skippedDocuments).toBe(4);
      expect(result.indexing?.processedDocuments).toBe(0);
    }
    // No document embeds on an identical run: the call delta is exactly the constant per-job
    // capability-probe cost, run after run — zero chunk embeddings.
    expect(adapter.calls() - callsAfterInitial).toBe(probeCost * 2);
  });

  it("re-indexes ONLY changed pages (embedding call counts), detects removals from the enumerated set, and reports exact counts", async () => {
    createShell();
    const adapter = countingAdapter();
    await initialSync(adapter);
    const callsAfterInitial = adapter.calls();
    expect(callsAfterInitial).toBeGreaterThan(0);

    // Mutations upstream: page 1 changed, page 5 added, page 4 removed, pages 2+3 unchanged.
    const resync = [
      pageItem(1, "Edited content one — new revision."),
      pageItem(2, "Original content two."),
      pageItem(3, "Original content three."),
      pageItem(5, "Brand new page five."),
    ];
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-resync",
      items: resync,
      enumeratedItemKeys: keysOf(resync),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    expect(result.changeSummary.outcome).toBe("succeeded");
    expect(result.changeSummary.counts).toEqual({
      addedItems: 1,
      changedItems: 1,
      removedItems: 1,
      unchangedItems: 2,
      failedItems: 0,
      deniedItems: 0,
    });

    // Unchanged pages skip re-embedding: exactly the changed page and the added page process.
    expect(adapter.calls()).toBeGreaterThan(callsAfterInitial);
    expect(result.indexing?.skippedDocuments).toBe(2);
    expect(result.indexing?.processedDocuments).toBe(2);

    // The removed page left the index and the fingerprint baseline.
    expect(result.summary.counts.documentCount).toBe(4);
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.has(`confluence:${CONNECTOR_ID}:4`)).toBe(false);
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "Original content four", capsuleId: CAPSULE_ID, topK: 10 },
    );
    const titles = retrieval.references.map((ref) => ref.citation.safeDisplayName);
    expect(titles).not.toContain("Page 4");
  });

  it("never counts a denied/failed item as removed (enumeration keeps it within scope)", async () => {
    createShell();
    const adapter = countingAdapter();
    await initialSync(adapter);
    const deniedKey = `confluence:${CONNECTOR_ID}:4`;
    const resync = [
      pageItem(1, "Original content one."),
      pageItem(2, "Original content two."),
      pageItem(3, "Original content three."),
    ];
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-resync",
      items: resync,
      enumeratedItemKeys: [...keysOf(resync), deniedKey],
      deniedItemKeys: [deniedKey],
      failedItemKeys: [],
    });
    expect(result.changeSummary.counts.removedItems).toBe(0);
    expect(result.changeSummary.counts.deniedItems).toBe(1);
    expect(result.changeSummary.outcome).toBe("partial");
  });

  it("applies an empty enumerated scope as full removal without touching the indexing pipeline", async () => {
    createShell();
    const adapter = countingAdapter();
    await initialSync(adapter);
    const callsAfterInitial = adapter.calls();
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-empty",
      items: [],
      enumeratedItemKeys: [],
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    expect(result.changeSummary.counts.removedItems).toBe(4);
    expect(result.changeSummary.outcome).toBe("succeeded");
    expect(adapter.calls()).toBe(callsAfterInitial);
    expect(result.summary.counts.documentCount).toBe(0);
    expect(readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID).size).toBe(0);
  });

  it("keeps the prior baseline when the indexing run itself fails (retry re-diffs the last good state)", async () => {
    createShell();
    const adapter = countingAdapter();
    const initial = await initialSync(adapter);
    const failingAdapter = scriptedAdapter({
      identity: DEFAULT_EMBEDDING,
      responder: (): OpenAIEmbeddingOutcome => ({ ok: false, kind: "timeout" }),
    });
    const resync = [pageItem(1, "Edited content one — new revision.")];
    const result = await applyConnectorSyncRun(
      { ...indexingDeps(adapter), embeddingAdapter: failingAdapter },
      {
        runId: "run-broken",
        items: resync,
        enumeratedItemKeys: keysOf(initial),
        deniedItemKeys: [],
        failedItemKeys: [],
      },
    );
    expect(result.changeSummary.outcome).toBe("failed");
    // Not applied: zero added/changed/removed, and the prior 4-item baseline is untouched so the
    // next attempt re-diffs against the last good state.
    expect(result.changeSummary.counts.addedItems).toBe(0);
    expect(result.changeSummary.counts.changedItems).toBe(0);
    expect(result.changeSummary.counts.removedItems).toBe(0);
    expect(readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID).size).toBe(4);
  });
});

describe("recordUnappliedConnectorSyncRun — degradation mapping", () => {
  it("maps auth-failed to an unavailable pod with credential remediation guidance", async () => {
    createShell();
    const adapter = countingAdapter();
    const items = [pageItem(1, "content")];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    const result = recordUnappliedConnectorSyncRun(
      { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
      { runId: "run-2", outcome: "failed", failureReason: "auth-failed" },
    );
    expect(result.changeSummary.outcome).toBe("failed");
    expect(result.changeSummary.counts.addedItems).toBe(0);
    expect(result.summary.readiness).toBe("unavailable");
    expect(
      result.summary.degradationReasons.some((reason) =>
        reason.includes("verify or rotate the Atlassian credential"),
      ),
    ).toBe(true);
    // The prior fingerprint baseline stays intact for the next attempt.
    expect(readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID).size).toBe(1);
  });

  it("keeps the pod state unchanged on a cancelled run and reports zero change counts", async () => {
    createShell();
    const adapter = countingAdapter();
    const items = [pageItem(1, "content")];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    const result = recordUnappliedConnectorSyncRun(
      { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
      { runId: "run-2", outcome: "cancelled" },
    );
    expect(result.changeSummary.outcome).toBe("cancelled");
    expect(getCapsule(store, CAPSULE_ID)?.lifecycleState).toBe("ready");
    expect(result.summary.counts.documentCount).toBe(1);
  });

  it("degrades a bounds-truncated run to partial guidance without committing anything", () => {
    createShell();
    const result = recordUnappliedConnectorSyncRun(
      { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
      { runId: "run-1", outcome: "partial", failureReason: "bounds-exceeded" },
    );
    expect(result.changeSummary.outcome).toBe("partial");
    expect(result.changeSummary.counts.removedItems).toBe(0);
    expect(result.summary.degradationReasons.some((reason) => reason.includes("run bounds"))).toBe(
      true,
    );
  });

  it("fails closed when no approved connector scope exists", () => {
    expect(() =>
      recordUnappliedConnectorSyncRun(
        { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
        { runId: "run-1", outcome: "failed", failureReason: "unavailable" },
      ),
    ).toThrow(/no approved connector source/u);
  });
});

describe("redaction (ADR-0128 D6)", () => {
  it("keeps page bodies and content out of every summary, change-summary, and metadata payload", async () => {
    createShell();
    const adapter = countingAdapter();
    const secretBody = "SECRET-BODY-MARKER-do-not-leak";
    const items = [pageItem(1, secretBody)];
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    const metadata = readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    const scanned = JSON.stringify({
      summary: result.summary,
      changeSummary: result.changeSummary,
      metadata,
    });
    expect(scanned).not.toContain(secretBody);
  });
});

// ─── Jira incremental carry-forward (#2243) ─────────────────────────────────────
function jiraItem(
  id: number,
  body: string,
  overrides: Partial<ConnectorSyncContentItem> = {},
): ConnectorSyncContentItem {
  const title = overrides.title ?? `PLAT-${String(id)}: Issue ${String(id)}`;
  const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return {
    itemKey: `jira:${CONNECTOR_ID}:${String(10_000 + id)}`,
    relativePath: `issues/${String(10_000 + id)}.html`,
    title,
    bytes: new TextEncoder().encode(html),
    webuiPath: `/browse/PLAT-${String(id)}`,
    citationMetadataJson: JSON.stringify({
      issueKey: `PLAT-${String(id)}`,
      status: "In Progress",
      issueType: "Bug",
      labels: ["auth"],
    }),
    ...overrides,
  };
}

function createJiraShell(): void {
  createConnectorPodShell(
    { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
    {
      definition: {
        provider: "jira",
        connectorId: CONNECTOR_ID,
        baseUrl: BASE_URL,
        scopeKeys: ["PLAT"],
        jql: "labels = auth",
        bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
      },
      displayName: "Platform Issues",
      embeddingModelIdentity: DEFAULT_EMBEDDING,
    },
  );
}

describe("applyConnectorSyncRun — Jira incremental carry-forward (#2243)", () => {
  const WATERMARK_1 = "2026-05-01T10:00:00.000+0000";
  const WATERMARK_2 = "2026-05-02T09:30:00.000+0000";

  async function initialJiraSync(
    adapter: CountingAdapter,
  ): Promise<readonly ConnectorSyncContentItem[]> {
    const items = [
      jiraItem(1, "Login fails on refresh."),
      jiraItem(2, "Token rotation is flaky."),
      jiraItem(3, "Session cache never expires."),
      jiraItem(4, "Password reset email delayed."),
    ];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-initial",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
      providerWatermark: WATERMARK_1,
    });
    return items;
  }

  it("persists the approved JQL and advances the provider watermark only on applied runs", async () => {
    createJiraShell();
    const adapter = countingAdapter();
    await initialJiraSync(adapter);
    const metadata = readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(metadata?.jql).toBe("labels = auth");
    expect(metadata?.providerWatermark).toBe(WATERMARK_1);

    recordUnappliedConnectorSyncRun(
      { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
      { runId: "run-cancelled", outcome: "cancelled" },
    );
    expect(readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)?.providerWatermark).toBe(
      WATERMARK_1,
    );
  });

  it("carries unchanged issues without re-indexing them: exact counts, retained documents, retained baseline metadata", async () => {
    createJiraShell();
    const adapter = countingAdapter();
    const initial = await initialJiraSync(adapter);
    const callsAfterInitial = adapter.calls();

    // Incremental run: only issue 1 changed and was re-fetched; issues 2-4 carry forward.
    const changed = jiraItem(1, "Login fails on refresh — new root cause identified.");
    const carriedKeys = keysOf(initial.slice(1));
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-incremental",
      items: [changed],
      enumeratedItemKeys: [changed.itemKey],
      deniedItemKeys: [],
      failedItemKeys: [],
      carriedItemKeys: carriedKeys,
      providerWatermark: WATERMARK_2,
    });
    expect(result.changeSummary.outcome).toBe("succeeded");
    expect(result.changeSummary.counts).toEqual({
      addedItems: 0,
      changedItems: 1,
      removedItems: 0,
      unchangedItems: 3,
      failedItems: 0,
      deniedItems: 0,
    });
    // Only the changed issue re-indexed (call-count evidence); carried documents stayed indexed.
    expect(result.indexing?.processedDocuments).toBe(1);
    expect(adapter.calls()).toBeGreaterThan(callsAfterInitial);
    expect(result.summary.counts.documentCount).toBe(4);
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "Session cache never expires", capsuleId: CAPSULE_ID, topK: 4 },
    );
    const titles = retrieval.references.map((ref) => ref.citation.safeDisplayName);
    expect(titles).toContain("PLAT-3: Issue 3");
    // Carried baseline entries survive verbatim, citation metadata included.
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.size).toBe(4);
    expect(fingerprints.get(`jira:${CONNECTOR_ID}:10003`)?.citationMetadataJson).toContain(
      '"issueKey":"PLAT-3"',
    );
    expect(readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)?.providerWatermark).toBe(
      WATERMARK_2,
    );
  });

  it("removes issues that left the enumerated set (deleted or moved out of JQL) on a carried run", async () => {
    createJiraShell();
    const adapter = countingAdapter();
    const initial = await initialJiraSync(adapter);
    // Issue 4 no longer matches the approved JQL upstream: not fetched, not carried.
    const carriedKeys = keysOf(initial.slice(1, 3));
    const changed = jiraItem(1, "Edited body.");
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-incremental",
      items: [changed],
      enumeratedItemKeys: [changed.itemKey],
      deniedItemKeys: [],
      failedItemKeys: [],
      carriedItemKeys: carriedKeys,
      providerWatermark: WATERMARK_2,
    });
    expect(result.changeSummary.counts).toMatchObject({
      changedItems: 1,
      removedItems: 1,
      unchangedItems: 2,
    });
    expect(result.summary.counts.documentCount).toBe(3);
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.has(`jira:${CONNECTOR_ID}:10004`)).toBe(false);
  });

  it("prunes the stale document of an issue that failed or was denied during a carried run", async () => {
    createJiraShell();
    const adapter = countingAdapter();
    const initial = await initialJiraSync(adapter);
    // Issue 1 updated upstream but its re-fetch was denied (403): enumerated, not fetched, not
    // carried. Its stale local copy must not linger as if current.
    const deniedKey = keysOf(initial)[0] ?? "";
    const carriedKeys = keysOf(initial.slice(1));
    const result = await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-incremental",
      items: [],
      enumeratedItemKeys: [deniedKey],
      deniedItemKeys: [deniedKey],
      failedItemKeys: [],
      carriedItemKeys: carriedKeys,
      providerWatermark: WATERMARK_2,
    });
    expect(result.changeSummary.outcome).toBe("partial");
    expect(result.changeSummary.counts).toMatchObject({
      removedItems: 0,
      deniedItems: 1,
      unchangedItems: 3,
    });
    expect(result.summary.counts.documentCount).toBe(3);
    const fingerprints = readConnectorItemFingerprints(store, CAPSULE_ID, SOURCE_ID);
    expect(fingerprints.has(deniedKey)).toBe(false);
  });

  it("resolves Jira citations to the browse URL with validated structured metadata", async () => {
    createJiraShell();
    const adapter = countingAdapter();
    const items = [
      jiraItem(1, "Login fails on refresh."),
      jiraItem(2, "Corrupt metadata row.", { citationMetadataJson: "{not json" }),
    ];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
      providerWatermark: WATERMARK_1,
    });
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "Login fails on refresh", capsuleId: CAPSULE_ID, topK: 2 },
    );
    const byTitle = new Map(
      retrieval.references.map((ref) => [ref.citation.safeDisplayName, ref.citation.documentId]),
    );
    const resolved = resolveConnectorCitationTarget(store, {
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
      documentId: byTitle.get("PLAT-1: Issue 1") ?? ("" as DocumentId),
    });
    expect(resolved).toMatchObject({
      ok: true,
      target: "https://tenant.example/browse/PLAT-1",
      pageTitle: "PLAT-1: Issue 1",
      itemKey: `jira:${CONNECTOR_ID}:10001`,
      citationMetadata: {
        issueKey: "PLAT-1",
        status: "In Progress",
        issueType: "Bug",
        labels: ["auth"],
      },
    });
    // An unvalidated persisted projection degrades to a link-only citation, never raw fields.
    const corrupt = resolveConnectorCitationTarget(store, {
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
      documentId: byTitle.get("PLAT-2: Issue 2") ?? ("" as DocumentId),
    });
    expect(corrupt.ok).toBe(true);
    if (corrupt.ok) expect(corrupt.citationMetadata).toBeUndefined();
  });
});

describe("resolveConnectorCitationTarget — fail-closed branches", () => {
  it("refuses unknown sources, unknown documents, and items without a webui link", async () => {
    expect(
      resolveConnectorCitationTarget(store, {
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
        documentId: "doc-x" as DocumentId,
      }),
    ).toEqual({ ok: false, reason: "source-metadata-unavailable" });

    createShell();
    expect(
      resolveConnectorCitationTarget(store, {
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
        documentId: "doc-x" as DocumentId,
      }),
    ).toEqual({ ok: false, reason: "citation-lineage-mismatch" });

    const adapter = countingAdapter();
    const items = [pageItem(1, "content", { webuiPath: undefined })];
    await applyConnectorSyncRun(indexingDeps(adapter), {
      runId: "run-1",
      items,
      enumeratedItemKeys: keysOf(items),
      deniedItemKeys: [],
      failedItemKeys: [],
    });
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "content", capsuleId: CAPSULE_ID, topK: 1 },
    );
    const documentId = retrieval.references[0]?.citation.documentId;
    expect(documentId).toBeDefined();
    expect(
      resolveConnectorCitationTarget(store, {
        capsuleId: CAPSULE_ID,
        sourceId: SOURCE_ID,
        documentId: documentId ?? ("" as DocumentId),
      }),
    ).toEqual({ ok: false, reason: "target-unsupported" });
  });
});
