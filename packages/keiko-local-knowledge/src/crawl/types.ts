// Bounded static HTML manual crawl — port + result types (Epic #1853, Issues #1872/#1873).
//
// keiko-local-knowledge performs NO network egress (ADR-0019 trust-9). The crawler here is a PURE
// orchestrator: it resolves the link graph, enforces the scope guard, deduplicates, and bounds the
// traversal, but the actual byte retrieval is delegated to an injected `ManualCrawlFetcher` port —
// exactly the pattern the indexing layer already uses for `WorkspaceFs` (filesystem) and the
// embedding adapter (model egress). In tests the port is an in-memory fixture; for a local manual
// it reads through `WorkspaceFs`; for an intranet manual `keiko-server` provides a
// `gatewayFetch`-backed implementation (ADR-0038 egress, DNS-rebinding-safe).

import type { DocumentationManualDeniedLinkClass } from "@oscharko-dev/keiko-contracts";

// Body-free reason a candidate link or a fetched page was refused. Reuses the #1852 denied-link
// classes and adds the crawl-runtime bounds. Never carries a raw URL/path.
export type ManualCrawlDenyReason =
  | DocumentationManualDeniedLinkClass // cross-origin | outside-path-prefix | unsupported-scheme | credentialed-url | path-traversal
  | "action-link"
  | "non-html"
  | "page-limit"
  | "depth-limit"
  | "byte-budget"
  | "time-limit"
  | "oversized-page"
  | "fetch-failed"
  | "redirect"
  | "empty-page";

// The target a fetcher is asked to retrieve. The runner canonicalises links into one of these
// before dispatch; the fetcher never parses or resolves links itself.
export type ManualFetchTarget =
  | { readonly kind: "http"; readonly url: string }
  | { readonly kind: "local"; readonly rootPath: string; readonly relativePath: string };

export interface ManualFetchOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

// Result of a single fetch. Body-free on failure; on success carries only the bytes, the reported
// content type, whether the origin returned a redirect the crawler must refuse, and whether the
// bytes were cut short by the per-page cap (the crawler denies a truncated page rather than
// indexing malformed, mid-tag-truncated HTML).
export type ManualFetchResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: string | null;
      readonly status?: number;
      readonly redirected?: boolean;
      readonly truncated?: boolean;
    }
  | { readonly ok: false; readonly reason: ManualCrawlDenyReason };

// The injected byte-retrieval port. Implementations MUST honour `maxBytes` (per-page cap) and MUST
// NOT follow redirects (the crawler enforces `followRedirects: false`).
export interface ManualCrawlFetcher {
  readonly fetchManualPage: (
    target: ManualFetchTarget,
    options: ManualFetchOptions,
  ) => Promise<ManualFetchResult>;
}

// A page accepted into the crawl graph. Internal runtime state (carries the page bytes); never sent
// to a browser surface. `relativePath` anchors the page in the indexing scope + citation base.
export interface CrawledManualPage {
  readonly canonicalKey: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly depth: number;
  readonly title: string | null;
}

// Body-free tally of refused links/pages, grouped by reason code.
export interface ManualCrawlDeniedTally {
  readonly reason: ManualCrawlDenyReason;
  readonly count: number;
}

export type ManualCrawlStatus = "completed" | "cancelled" | "limit-reached" | "empty";

export interface ManualCrawlStats {
  readonly discovered: number;
  readonly fetched: number;
  readonly accepted: number;
  readonly deniedCount: number;
  readonly bytesFetched: number;
}

export interface ManualCrawlResult {
  readonly status: ManualCrawlStatus;
  readonly pages: readonly CrawledManualPage[];
  readonly denied: readonly ManualCrawlDeniedTally[];
  readonly stats: ManualCrawlStats;
}

// Optional, body-free progress event stream consumed by the lifecycle surface (#1875).
export type ManualCrawlEvent =
  | { readonly kind: "page-accepted"; readonly relativePath: string; readonly depth: number }
  | { readonly kind: "link-denied"; readonly reason: ManualCrawlDenyReason }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "completed";
      readonly status: ManualCrawlStatus;
      readonly accepted: number;
      readonly deniedCount: number;
    };
