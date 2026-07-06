// Body-free HTML manual indexing progress projection (Epic #1853, Issue #1875).
//
// Reuses the crawl result (#1872) and the existing `runIndexingJob` lifecycle (`IndexingResult`)
// rather than adding a second job system. It projects both phases into a single server/UI-safe
// progress record — counts, statuses, denied-link reason codes, and generic remediation guidance
// only. No raw URL, local path, page body, or diagnostic text ever appears. Cancellation and
// partial-failure are first-class phases, so a cancelled or partially-failed manual can never read
// as a fully "ready" pod.

import type {
  ManualCrawlDeniedTally,
  ManualCrawlResult,
  ManualCrawlStatus,
} from "./crawl/index.js";
import type { IndexingResult } from "./indexing/index.js";

export type ManualIndexingPhase = "crawling" | "ready" | "degraded" | "cancelled" | "empty";

export interface ManualCrawlProgress {
  readonly status: ManualCrawlStatus;
  readonly discovered: number;
  readonly accepted: number;
  readonly deniedCount: number;
  readonly bytesFetched: number;
}

export interface ManualIndexingCounts {
  readonly status: IndexingResult["status"];
  readonly totalDocuments: number;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly vectorsPersisted: number;
}

export interface ManualRemediation {
  readonly reason: string;
  readonly guidance: string;
}

export interface HtmlManualIndexingProgress {
  readonly phase: ManualIndexingPhase;
  readonly crawl: ManualCrawlProgress;
  readonly indexing: ManualIndexingCounts | null;
  readonly deniedLinks: readonly ManualCrawlDeniedTally[];
  readonly remediations: readonly ManualRemediation[];
}

// Generic, body-free operator guidance keyed by reason code. Never references a specific URL/path.
const REMEDIATION_GUIDANCE: Readonly<Record<string, string>> = {
  "cross-origin": "Links pointing outside the approved manual origin were skipped.",
  "outside-path-prefix": "Links outside the approved path prefix were skipped.",
  "unsupported-scheme": "Links using a non-crawled scheme (mailto, javascript, …) were skipped.",
  "credentialed-url": "A link embedding credentials was refused.",
  "path-traversal": "A link attempting to leave the approved manual root was refused.",
  "action-link": "Login, logout, and other action links were skipped.",
  "non-html": "Non-document assets (styles, scripts, images) were skipped.",
  redirect: "A page redirected; redirects are not followed for static manuals.",
  "oversized-page": "A page exceeded the per-page byte cap and was skipped.",
  "byte-budget": "The manual reached its total byte budget; narrow the scope or raise the limit.",
  "page-limit": "The manual reached its page limit; some pages were not crawled.",
  "depth-limit": "The manual reached its depth limit; deeper pages were not crawled.",
  "fetch-failed": "Some pages could not be retrieved.",
  "empty-page": "Some pages had no indexable content.",
  POLICY_DENIED: "The pod's model-use policy denied the embedding operation; review the policy.",
  INCOMPATIBLE_EMBEDDING_IDENTITY: "The embedding model changed; re-index the manual to continue.",
  EMBEDDING_ADAPTER_FAILED: "The embedding provider was unavailable; retry indexing.",
  DISCOVERY_FAILED: "The manual pages could not be read for indexing.",
  CHUNKING_FAILED: "A page could not be chunked for indexing.",
  PERSISTENCE_FAILED: "The index could not be written to local storage.",
};

function crawlProgress(crawl: ManualCrawlResult): ManualCrawlProgress {
  return {
    status: crawl.status,
    discovered: crawl.stats.discovered,
    accepted: crawl.stats.accepted,
    deniedCount: crawl.stats.deniedCount,
    bytesFetched: crawl.stats.bytesFetched,
  };
}

function indexingCounts(indexing: IndexingResult | undefined): ManualIndexingCounts | null {
  if (indexing === undefined) return null;
  return {
    status: indexing.status,
    totalDocuments: indexing.totalDocuments,
    processedDocuments: indexing.processedDocuments,
    failedDocuments: indexing.failedDocuments,
    skippedDocuments: indexing.skippedDocuments,
    vectorsPersisted: indexing.vectorsPersisted,
  };
}

function resolvePhase(
  crawl: ManualCrawlResult,
  indexing: IndexingResult | undefined,
): ManualIndexingPhase {
  if (crawl.status === "cancelled" || indexing?.status === "cancelled") return "cancelled";
  if (indexing === undefined) return crawl.status === "empty" ? "empty" : "crawling";
  if (indexing.status === "succeeded" && indexing.failedDocuments === 0) return "ready";
  return "degraded";
}

function remediationReasons(
  crawl: ManualCrawlResult,
  indexing: IndexingResult | undefined,
): readonly string[] {
  const codes = new Set<string>(crawl.denied.map((tally) => tally.reason));
  const indexingCode: string | undefined = indexing?.lastError?.code;
  if (indexingCode !== undefined) codes.add(indexingCode);
  return [...codes];
}

function collectRemediations(
  crawl: ManualCrawlResult,
  indexing: IndexingResult | undefined,
): readonly ManualRemediation[] {
  const remediations: ManualRemediation[] = [];
  for (const reason of remediationReasons(crawl, indexing)) {
    const guidance = REMEDIATION_GUIDANCE[reason];
    if (guidance !== undefined) remediations.push({ reason, guidance });
  }
  return remediations;
}

// Project a crawl (and, when it ran, its indexing job) into a single body-free progress record for
// server/UI consumption. Only reasons that actually occurred carry remediation guidance.
export function buildHtmlManualIndexingProgress(
  crawl: ManualCrawlResult,
  indexing?: IndexingResult,
): HtmlManualIndexingProgress {
  return {
    phase: resolvePhase(crawl, indexing),
    crawl: crawlProgress(crawl),
    indexing: indexingCounts(indexing),
    deniedLinks: crawl.denied,
    remediations: collectRemediations(crawl, indexing),
  };
}
