// Explicit refresh for an approved HTML Manual Knowledge Pod (Epic #1856, Issue #1891).
//
// Re-runs the EXACT bounded crawl a pod was created from, then re-indexes the reachable pages over
// the existing capsule/source using the incremental indexing lifecycle (unchanged pages skip,
// changed pages re-embed, removed pages prune). It reuses the create-time machinery end to end —
// `crawlManual`, `runIndexingJob`, `buildKnowledgePodSummary` — and adds no second crawl or
// retrieval path.
//
// Governance invariants (Epic #1856):
//   • Scope preservation: the crawl scope + limits are reconstructed ONLY from persisted approved
//     state (`html_manual_sources`); the caller cannot supply or widen a scope. The scope guard in
//     `crawlManual` still fails closed on every escape vector.
//   • Fail closed on limits: a crawl that reaches its page/byte/depth/time limit is NOT applied
//     (a truncated crawl is not an authoritative view of the manual); the previous pod is left fully
//     usable and the operator is told to narrow scope or raise the limit.
//   • A cancelled or empty crawl never overwrites the previous usable pod state.

import { randomUUID } from "node:crypto";

import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  HTML_MANUAL_SOURCE_SCHEMA_VERSION,
  htmlManualReachableFilesScope,
  validateHtmlManualSource,
  type HtmlManualCrawlScope,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgePodSummary,
  type KnowledgeSourceId,
  type ManualRefreshChangeSummary,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";

import { getCapsule } from "./capsule-lifecycle.js";
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
  computeManualPageFingerprint,
  readManualPageFingerprints,
  replaceManualPageFingerprints,
  type ManualPageFingerprint,
} from "./manual-page-fingerprints.js";
import { computeManualRefreshChangeSummary } from "./manual-refresh-change-summary.js";
import {
  buildHtmlManualIndexingProgress,
  type HtmlManualIndexingProgress,
} from "./manual-pod-progress.js";
import {
  HTML_MANUAL_SOURCE_SCOPE_VERSION,
  readHtmlManualSourceMetadata,
  updateHtmlManualRefreshState,
  type HtmlManualSourceMetadata,
} from "./manual-source-metadata.js";
import type { AuditEventSink } from "./privacy/index.js";
import type { ParserRegistry } from "./parsers/index.js";
import { listCapsuleSources, updateSourceScopeInCapsule } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

export interface RefreshHtmlManualPodDeps {
  readonly store: KnowledgeStore;
  readonly parserRegistry: ParserRegistry;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  // Injected byte-retrieval port (WorkspaceFs-backed for local manuals). A gatewayFetch-backed
  // keiko-server fetcher for intranet manuals is NOT implemented yet, and this function has no
  // live server route or UI trigger — see Issue #2063. The refresh never constructs a fetcher
  // itself (trust-9).
  readonly fetcher: ManualCrawlFetcher;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly idSource?: () => string;
  readonly auditSink?: AuditEventSink;
  readonly onCrawlEvent?: (event: ManualCrawlEvent) => void;
  readonly onIndexEvent?: (event: IndexingEvent) => void;
}

export interface RefreshHtmlManualPodResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly crawl: ManualCrawlResult;
  // Absent when the refresh failed closed before applying (limit-reached, empty, or cancelled crawl).
  readonly indexing?: IndexingResult;
  readonly summary: KnowledgePodSummary;
  readonly progress: HtmlManualIndexingProgress;
  // Redacted change summary (#1892): counts + reason codes + opaque crawl-run fingerprint only.
  readonly changeSummary: ManualRefreshChangeSummary;
}

// Rebuild the approved crawl scope from persisted metadata ONLY — never from caller input, so a
// refresh cannot widen the approved origin/root/path-prefix.
function reconstructScope(metadata: HtmlManualSourceMetadata): HtmlManualCrawlScope | undefined {
  if (metadata.sourceKind === "html-manual-local") {
    if (metadata.rootPath === undefined) return undefined;
    return {
      kind: "html-manual-local",
      rootPath: metadata.rootPath,
      ...(metadata.entryPath !== undefined ? { entryPath: metadata.entryPath } : {}),
    };
  }
  if (metadata.origin === undefined) return undefined;
  return {
    kind: "html-manual-http",
    origin: metadata.origin,
    pathPrefix: metadata.pathPrefix ?? null,
  };
}

// Reconstruct and re-validate the approved source. The persisted limits pin the exact bounded crawl;
// a legacy row written before limits were persisted falls back to the governed defaults (which are
// the maximum allowed bound, so this never widens beyond policy).
function reconstructHtmlManualSource(
  metadata: HtmlManualSourceMetadata,
  proposedPodName: string,
): HtmlManualSource {
  if (
    metadata.sourceScopeVersion !== undefined &&
    metadata.sourceScopeVersion !== HTML_MANUAL_SOURCE_SCOPE_VERSION
  ) {
    throw new KnowledgeStoreError("persisted manual source scope version is unsupported");
  }
  const scope = reconstructScope(metadata);
  if (scope === undefined) {
    throw new KnowledgeStoreError("persisted manual scope is incomplete; cannot refresh");
  }
  const result = validateHtmlManualSource({
    schemaVersion: HTML_MANUAL_SOURCE_SCHEMA_VERSION,
    scope,
    limits: metadata.limits ?? DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: metadata.sourceFingerprint,
    proposedPodName,
  });
  if (!result.ok) {
    throw new KnowledgeStoreError(
      `persisted manual source is invalid; cannot refresh: ${result.errors.join("; ")}`,
    );
  }
  return result.value;
}

function pagesToFingerprints(crawl: ManualCrawlResult): readonly ManualPageFingerprint[] {
  return crawl.pages.map((page) => ({
    relativePath: page.relativePath,
    contentFingerprint: computeManualPageFingerprint(page.bytes),
    byteLength: page.bytes.byteLength,
  }));
}

interface DrainedRefreshIndexing {
  readonly result: IndexingResult | undefined;
  // Relative paths of documents that hit a `document-failed` event during this run. Tracked
  // separately from `result` because `IndexingResult.status` only reports "failed" when EVERY
  // document in the run failed (see orchestrator.ts `resolveJobStatus`) — a run where some
  // documents succeed and others fail is still reported "succeeded", which would otherwise hide
  // the failed pages from the fingerprint-baseline bookkeeping below.
  readonly failedRelativePaths: ReadonlySet<string>;
}

async function drainRefreshIndexing(
  events: AsyncIterable<IndexingEvent>,
  onEvent?: (event: IndexingEvent) => void,
): Promise<DrainedRefreshIndexing> {
  let result: IndexingResult | undefined;
  const failedRelativePaths = new Set<string>();
  for await (const event of events) {
    onEvent?.(event);
    if (event.kind === "document-failed" && event.relativePath !== undefined) {
      failedRelativePaths.add(event.relativePath);
    }
    if (
      event.kind === "job-completed" ||
      event.kind === "job-failed" ||
      event.kind === "job-cancelled"
    ) {
      result = event.result;
    }
  }
  return { result, failedRelativePaths };
}

function runRefreshIndexing(
  deps: RefreshHtmlManualPodDeps,
  rootPath: string,
  crawl: ManualCrawlResult,
): Promise<DrainedRefreshIndexing> {
  const workspaceFs = createManualPageWorkspaceFs(rootPath, crawl.pages);
  const events = runIndexingJob({
    capsuleId: deps.capsuleId,
    sourceIds: [deps.sourceId],
    parserRegistry: deps.parserRegistry,
    workspaceFs,
    embeddingAdapter: deps.embeddingAdapter,
    store: deps.store,
    ...(deps.auditSink !== undefined ? { auditSink: deps.auditSink } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.idSource !== undefined ? { idSource: deps.idSource } : {}),
  });
  return drainRefreshIndexing(events, deps.onIndexEvent);
}

interface ResolvedSource {
  readonly source: HtmlManualSource;
  readonly rootPath: string;
}

// Load + validate everything a refresh needs from persisted state, failing closed if the pod is not
// a crawled HTML manual or its approved scope is incomplete.
function resolveRefreshSource(deps: RefreshHtmlManualPodDeps): ResolvedSource {
  const metadata = readHtmlManualSourceMetadata(deps.store, deps.capsuleId, deps.sourceId);
  if (metadata === undefined) {
    throw new KnowledgeStoreError("no approved HTML manual source to refresh");
  }
  const attached = listCapsuleSources(deps.store, deps.capsuleId).find(
    (candidate) => candidate.id === deps.sourceId,
  );
  if (attached?.scope.kind !== "files") {
    throw new KnowledgeStoreError("manual source is not a crawled HTML manual; cannot refresh");
  }
  return {
    source: reconstructHtmlManualSource(metadata, attached.displayName),
    rootPath: attached.scope.rootPath,
  };
}

interface AppliedRefresh {
  readonly indexing: IndexingResult | undefined;
  readonly newPages: readonly ManualPageFingerprint[];
}

// A job only reports "failed" when EVERY document in the run failed (orchestrator.ts
// `resolveJobStatus`); a run where some documents succeed and others fail is still reported
// "succeeded". Exclude any page whose document hit a `document-failed` event from the pages we
// commit to the fingerprint baseline, so that specific page keeps no verified baseline entry —
// otherwise a later refresh would see its unindexed content as "unchanged" and never retry it,
// silently hiding the failure behind an apparently caught-up pod.
function pagesToCommitToBaseline(
  newPages: readonly ManualPageFingerprint[],
  failedRelativePaths: ReadonlySet<string>,
): readonly ManualPageFingerprint[] {
  if (failedRelativePaths.size === 0) return newPages;
  return newPages.filter((page) => !failedRelativePaths.has(page.relativePath));
}

// Apply a completed crawl to the pod: update the source scope to the new page set (which prunes
// removed pages and includes added ones), re-index incrementally, and — only on a clean success —
// advance the persisted per-page fingerprint baseline. A failed or cancelled index keeps the prior
// baseline so a retry re-diffs against the last good state.
async function applyRefresh(
  deps: RefreshHtmlManualPodDeps,
  rootPath: string,
  crawl: ManualCrawlResult,
  crawlRunId: string,
): Promise<AppliedRefresh> {
  const newPages = pagesToFingerprints(crawl);
  const newScope = htmlManualReachableFilesScope(
    rootPath,
    crawl.pages.map((page) => page.relativePath),
  );
  if (newScope === null) {
    throw new KnowledgeStoreError("refreshed manual produced an unsafe indexing scope");
  }
  updateSourceScopeInCapsule(deps.store, deps.capsuleId, deps.sourceId, newScope);
  const { result: indexing, failedRelativePaths } = await runRefreshIndexing(deps, rootPath, crawl);
  // Advance the persisted fingerprint baseline only on a clean success; a failed or cancelled index
  // keeps the prior baseline so a retry re-diffs against the last good state. Within a "succeeded"
  // run, still withhold the baseline entry for any page whose own document failed (see
  // `pagesToCommitToBaseline`).
  if (indexing?.status === "succeeded") {
    const committedPages = pagesToCommitToBaseline(newPages, failedRelativePaths);
    replaceManualPageFingerprints(
      deps.store,
      deps.capsuleId,
      deps.sourceId,
      committedPages,
      crawlRunId,
    );
  }
  return { indexing, newPages };
}

// A crawl that completed within budget and produced pages is the only case a refresh applies. A
// limit-reached crawl fails closed (truncated, non-authoritative); empty/cancelled leave prior state.
function shouldApply(crawl: ManualCrawlResult): boolean {
  return crawl.status === "completed" && crawl.pages.length > 0;
}

export async function refreshHtmlManualPod(
  deps: RefreshHtmlManualPodDeps,
): Promise<RefreshHtmlManualPodResult> {
  const { store, capsuleId, sourceId } = deps;
  const resolved = resolveRefreshSource(deps);
  const priorFingerprints = readManualPageFingerprints(store, capsuleId, sourceId);
  const now = (deps.now ?? store._internal.now)();
  const crawlRunId = deps.idSource?.() ?? randomUUID();

  const crawl = await crawlManual(
    {
      fetcher: deps.fetcher,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.onCrawlEvent !== undefined ? { onEvent: deps.onCrawlEvent } : {}),
    },
    resolved.source,
  );

  const willApply = shouldApply(crawl);
  const applied: AppliedRefresh = willApply
    ? await applyRefresh(deps, resolved.rootPath, crawl, crawlRunId)
    : { indexing: undefined, newPages: pagesToFingerprints(crawl) };

  const changeSummary = computeManualRefreshChangeSummary({
    priorFingerprints,
    newPages: applied.newPages,
    crawl,
    indexing: applied.indexing,
    sourceKind: resolved.source.scope.kind,
    applied: willApply,
    refreshedAt: now,
  });
  updateHtmlManualRefreshState(store, capsuleId, sourceId, {
    lastRefreshedAt: now,
    lastCrawlRunId: crawlRunId,
    changeSummaryJson: JSON.stringify(changeSummary),
  });

  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) {
    throw new KnowledgeStoreError("manual capsule vanished during refresh");
  }
  return {
    capsuleId,
    sourceId,
    crawl,
    ...(applied.indexing !== undefined ? { indexing: applied.indexing } : {}),
    summary: buildKnowledgePodSummary(store, capsule),
    progress: buildHtmlManualIndexingProgress(crawl, applied.indexing),
    changeSummary,
  };
}
