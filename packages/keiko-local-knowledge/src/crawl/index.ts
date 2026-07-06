// Public surface of the static HTML manual crawl subsystem (Epic #1853).
//
// A pure, egress-free link-graph crawler that turns an approved `HtmlManualSource` into a bounded
// page set for the existing Local Knowledge indexing pipeline. Byte retrieval is delegated to an
// injected `ManualCrawlFetcher` (ADR-0019 trust-9: no network here).

export type {
  CrawledManualPage,
  ManualCrawlDeniedTally,
  ManualCrawlDenyReason,
  ManualCrawlEvent,
  ManualCrawlFetcher,
  ManualCrawlResult,
  ManualCrawlStats,
  ManualCrawlStatus,
  ManualFetchOptions,
  ManualFetchResult,
  ManualFetchTarget,
} from "./types.js";
export {
  evaluateManualCrawlLink,
  type CrawlLinkDecision,
  type EvaluateManualCrawlLinkInput,
} from "./scope-guard.js";
export { extractManualLinks, extractManualTitle } from "./link-extract.js";
export { crawlManual, type ManualCrawlDeps } from "./crawl-runner.js";
export {
  createInMemoryManualFetcher,
  createWorkspaceFsManualFetcher,
  type InMemoryManualPage,
  type WorkspaceFsManualFetcherDeps,
} from "./fetchers.js";
export { createManualPageWorkspaceFs } from "./manual-page-fs.js";
