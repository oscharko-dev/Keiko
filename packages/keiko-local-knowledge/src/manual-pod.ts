// Approved HTML manual → local Knowledge Pod integration (Epic #1853, Issue #1874).
//
// Turns an approved `HtmlManualSource` into an actual Knowledge Pod by REUSING the existing Local
// Knowledge machinery end to end: the pure crawler (#1872) captures the bounded page set, those
// bytes are exposed through an in-memory `WorkspaceFs`, and a `files` scope over the reachable pages
// flows through `runIndexingJob` — the same parser registry, HTML parser, chunker, lexical + vector
// indexing, checkpoint, and lifecycle a folder source already uses. No second store, no parallel
// retrieval path. Byte retrieval is injected (`ManualCrawlFetcher`, ADR-0019 trust-9).

import {
  htmlManualReachableFilesScope,
  standardPodModelUsePolicy,
  type EmbeddingModelIdentity,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgePodModelUsePolicy,
  type KnowledgePodSummary,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";

import { createCapsule, getCapsule } from "./capsule-lifecycle.js";
import {
  crawlManual,
  createManualPageWorkspaceFs,
  type ManualCrawlEvent,
  type ManualCrawlFetcher,
  type ManualCrawlResult,
} from "./crawl/index.js";
import { KnowledgeStoreError } from "./errors.js";
import { runIndexingJob, type IndexingEvent, type IndexingResult } from "./indexing/index.js";
import { buildKnowledgePodSummary } from "./knowledge-pods.js";
import {
  buildHtmlManualIndexingProgress,
  type HtmlManualIndexingProgress,
} from "./manual-pod-progress.js";
import type { AuditEventSink } from "./privacy/index.js";
import type { ParserRegistry } from "./parsers/index.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

// Absolute synthetic root the crawled pages are mounted under for indexing. It never touches disk —
// the in-memory page fs serves the bytes — but is a safe absolute path so the walker's containment
// gate holds.
const MANUAL_VIRTUAL_ROOT_PREFIX = "/keiko-html-manual";

export interface CreateHtmlManualPodDeps {
  readonly store: KnowledgeStore;
  readonly parserRegistry: ParserRegistry;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  // Injected byte-retrieval port (in-memory fixture in tests, WorkspaceFs-backed for local manuals,
  // gatewayFetch-backed in keiko-server for intranet manuals).
  readonly fetcher: ManualCrawlFetcher;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly idSource?: () => string;
  readonly auditSink?: AuditEventSink;
  readonly onCrawlEvent?: (event: ManualCrawlEvent) => void;
  readonly onIndexEvent?: (event: IndexingEvent) => void;
}

export interface CreateHtmlManualPodResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly sourceFingerprint: string;
  readonly crawl: ManualCrawlResult;
  // Absent when the crawl produced no page (an empty/degraded pod is still created).
  readonly indexing?: IndexingResult;
  readonly summary: KnowledgePodSummary;
  // Body-free progress projection (counts, phase, denied reasons, remediation) for server/UI.
  readonly progress: HtmlManualIndexingProgress;
}

function createManualCapsule(deps: CreateHtmlManualPodDeps, source: HtmlManualSource): void {
  createCapsule(
    deps.store,
    {
      id: deps.capsuleId,
      displayName: source.proposedPodName,
      tags: [],
      retrievalEffort: "default",
      outputMode: "answers",
      answerGroundingPolicy: "require-citations-or-state-no-evidence",
      // A static documentation manual is not sealed-sensitive, so it defaults to the standard
      // (local-first, external-embeddings-permitted) policy; a caller may override with a sealed
      // policy for a confidential intranet manual.
      modelUsePolicy: deps.modelUsePolicy ?? standardPodModelUsePolicy(),
      embeddingModelIdentity: deps.embeddingModelIdentity,
      lifecycleState: "draft",
      storageReference: `capsules/${deps.capsuleId}`,
    },
    deps.auditSink,
  );
}

// Attach the crawled page set as a `files` source so only link-reachable pages are indexed. Returns
// the synthetic root the pages were mounted under, or null when there is nothing safe to index — an
// empty crawl, or a cancelled crawl whose partial pages must NOT be published as a ready pod.
function attachManualSource(
  deps: CreateHtmlManualPodDeps,
  source: HtmlManualSource,
  crawl: ManualCrawlResult,
): string | null {
  if (crawl.pages.length === 0 || crawl.status === "cancelled") return null;
  const rootPath = `${MANUAL_VIRTUAL_ROOT_PREFIX}/${deps.capsuleId}`;
  const scope = htmlManualReachableFilesScope(
    rootPath,
    crawl.pages.map((page) => page.relativePath),
  );
  if (scope === null) {
    throw new KnowledgeStoreError("crawled manual produced an unsafe indexing scope");
  }
  addSourceToCapsule(
    deps.store,
    deps.capsuleId,
    { id: deps.sourceId, displayName: source.proposedPodName, tags: [], scope },
    deps.auditSink,
  );
  return rootPath;
}

async function drainIndexing(
  events: AsyncIterable<IndexingEvent>,
  onEvent?: (event: IndexingEvent) => void,
): Promise<IndexingResult | undefined> {
  let result: IndexingResult | undefined;
  for await (const event of events) {
    onEvent?.(event);
    if (
      event.kind === "job-completed" ||
      event.kind === "job-failed" ||
      event.kind === "job-cancelled"
    ) {
      result = event.result;
    }
  }
  return result;
}

function runManualIndexing(
  deps: CreateHtmlManualPodDeps,
  rootPath: string,
  crawl: ManualCrawlResult,
): Promise<IndexingResult | undefined> {
  const workspaceFs = createManualPageWorkspaceFs(rootPath, crawl.pages);
  const events = runIndexingJob({
    capsuleId: deps.capsuleId,
    parserRegistry: deps.parserRegistry,
    workspaceFs,
    embeddingAdapter: deps.embeddingAdapter,
    store: deps.store,
    ...(deps.auditSink !== undefined ? { auditSink: deps.auditSink } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.idSource !== undefined ? { idSource: deps.idSource } : {}),
  });
  return drainIndexing(events, deps.onIndexEvent);
}

// Create a local Knowledge Pod from an approved HTML manual: crawl → index reachable pages → build a
// redacted pod summary. The pod is created even when the crawl is empty (it is reported as a
// degraded pod with safe counts), so failures surface through lifecycle state rather than an
// exception.
export async function createHtmlManualPod(
  deps: CreateHtmlManualPodDeps,
  source: HtmlManualSource,
): Promise<CreateHtmlManualPodResult> {
  const crawl = await crawlManual(
    {
      fetcher: deps.fetcher,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.onCrawlEvent !== undefined ? { onEvent: deps.onCrawlEvent } : {}),
    },
    source,
  );
  createManualCapsule(deps, source);
  const rootPath = attachManualSource(deps, source, crawl);
  const indexing = rootPath === null ? undefined : await runManualIndexing(deps, rootPath, crawl);
  const capsule = getCapsule(deps.store, deps.capsuleId);
  if (capsule === undefined) {
    throw new KnowledgeStoreError("manual capsule vanished during indexing");
  }
  const summary = buildKnowledgePodSummary(deps.store, capsule);
  return {
    capsuleId: deps.capsuleId,
    sourceId: deps.sourceId,
    sourceFingerprint: source.sourceFingerprint,
    crawl,
    ...(indexing !== undefined ? { indexing } : {}),
    summary,
    progress: buildHtmlManualIndexingProgress(crawl, indexing),
  };
}
