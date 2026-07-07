// End-to-end closure evidence for static HTML Manual Knowledge Pod creation (Epic #1853, #1877).
//
// Proves the full path: an approved manual → bounded crawl → existing indexing pipeline → a ready
// Knowledge Pod with safe counts → the SAME `runLocalKnowledgeRetrieval` path other pods use returns
// grounded references over the manual. Hermetic and network-free: the byte source is an in-memory
// fixture fetcher and the embedding adapter is deterministic. A constant embedding is used ONLY so a
// query reliably matches an indexed chunk — this proves index presence and the retrieval path, and
// makes no claim about final answer quality (deferred to #1855).

import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import { createInMemoryManualFetcher } from "./crawl/index.js";
import { legacyManualFixture, MANUAL_FIXTURE_ORIGIN } from "./crawl/manual-fixtures.js";
import { createHtmlManualPod } from "./manual-pod.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import { runLocalKnowledgeRetrieval } from "./retrieval/index.js";
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

// A constant unit-ish embedding so a query vector matches every indexed chunk vector (cosine ≈ 1).
const CONSTANT_VECTOR = new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(1);

function constantAdapter(): ReturnType<typeof scriptedAdapter> {
  return scriptedAdapter({
    identity: DEFAULT_EMBEDDING,
    responder: (): OpenAIEmbeddingOutcome => ({
      ok: true,
      value: { vector: CONSTANT_VECTOR, modelId: DEFAULT_EMBEDDING.modelId },
    }),
  });
}

function httpManualSource(): HtmlManualSource {
  return {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: MANUAL_FIXTURE_ORIGIN, pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-e2e",
    proposedPodName: "Product Handbook",
  };
}

describe("HTML Manual Knowledge Pod — end-to-end evidence (#1877)", () => {
  it("creates a ready pod and retrieves grounded, body-free references over the manual", async () => {
    const adapter = constantAdapter();
    const pod = await createHtmlManualPod(
      {
        store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: adapter,
        embeddingModelIdentity: DEFAULT_EMBEDDING,
        fetcher: createInMemoryManualFetcher(legacyManualFixture()),
        capsuleId: "cap-e2e" as KnowledgeCapsuleId,
        sourceId: "src-e2e" as KnowledgeSourceId,
      },
      httpManualSource(),
    );

    // Pod is ready with safe counts.
    expect(pod.summary.readiness).toBe("ready");
    expect(pod.summary.counts.documentCount).toBe(4);
    expect(pod.summary.counts.chunkCount).toBeGreaterThan(0);
    expect(pod.summary.counts.vectorCount).toBeGreaterThan(0);
    expect(pod.progress.phase).toBe("ready");
    // Denied/skipped counts are part of the recorded closure evidence (#1877): a clean reference
    // run crawls no out-of-scope or duplicate link, and indexes every discovered page.
    expect(pod.progress.crawl.deniedCount).toBe(0);
    expect(pod.progress.indexing?.skippedDocuments).toBe(0);

    // The pod is searchable through the existing retrieval path.
    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter },
      { text: "installation steps", capsuleId: pod.capsuleId, topK: 5 },
    );
    expect(retrieval.noEvidence).toBe(false);
    expect(retrieval.references.length).toBeGreaterThan(0);

    // Retrieval references are body-free: the excerpt is a hash, and only safe citation metadata
    // (page label, heading path, offsets) crosses the wire — never the raw page body or a URL.
    const serialized = JSON.stringify(retrieval.references);
    expect(serialized).not.toContain("Welcome to the handbook");
    expect(serialized).not.toContain("settings file at startup");
    expect(serialized).not.toMatch(/https?:\/\//u);
    // References carry capsule/document/chunk lineage back to the manual pod, not raw text.
    expect(retrieval.references[0]?.citation.capsuleId).toBe(pod.capsuleId);
  });
});
