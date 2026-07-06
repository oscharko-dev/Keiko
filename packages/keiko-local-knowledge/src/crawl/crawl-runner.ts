// Bounded static HTML manual link-graph crawl runner (Epic #1853, Issue #1872).
//
// A breadth-first traversal from the approved entry page. Every step is bounded by the governed
// scope limits (pages, depth, total bytes, per-page cap, wall-clock, link sample) and routed through
// the pure scope guard before a fetch is dispatched to the injected `ManualCrawlFetcher`. It
// executes no JavaScript, follows no redirects, and deduplicates by canonical key. The output is a
// deterministic, bounded page set plus a body-free tally of refused links — the ingestion input for
// #1874.

import type { HtmlManualCrawlScope, HtmlManualSource } from "@oscharko-dev/keiko-contracts";
import { extractManualLinks, extractManualTitle } from "./link-extract.js";
import { evaluateManualCrawlLink, type CrawlLinkDecision } from "./scope-guard.js";
import type {
  CrawledManualPage,
  ManualCrawlDenyReason,
  ManualCrawlEvent,
  ManualCrawlFetcher,
  ManualCrawlResult,
  ManualCrawlStatus,
  ManualFetchResult,
  ManualFetchTarget,
} from "./types.js";

export interface ManualCrawlDeps {
  readonly fetcher: ManualCrawlFetcher;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onEvent?: (event: ManualCrawlEvent) => void;
}

interface QueueItem {
  readonly canonicalKey: string;
  readonly relativePath: string;
  readonly target: ManualFetchTarget;
  readonly depth: number;
}

interface CrawlState {
  readonly queue: QueueItem[];
  readonly seen: Set<string>;
  readonly pages: CrawledManualPage[];
  readonly denied: Map<ManualCrawlDenyReason, number>;
  discovered: number;
  fetched: number;
  bytesFetched: number;
  limitReached: boolean;
}

const DEFAULT_LOCAL_ENTRY = "index.html";

function tallyDeny(state: CrawlState, deps: ManualCrawlDeps, reason: ManualCrawlDenyReason): void {
  state.denied.set(reason, (state.denied.get(reason) ?? 0) + 1);
  deps.onEvent?.({ kind: "link-denied", reason });
}

function enqueueDecision(
  state: CrawlState,
  deps: ManualCrawlDeps,
  decision: CrawlLinkDecision,
): void {
  if (!decision.allow) {
    tallyDeny(state, deps, decision.reason);
    return;
  }
  if (state.seen.has(decision.canonicalKey)) return;
  state.seen.add(decision.canonicalKey);
  state.queue.push({
    canonicalKey: decision.canonicalKey,
    relativePath: decision.relativePath,
    target: decision.target,
    depth: decision.depth,
  });
}

function seedDecision(scope: HtmlManualCrawlScope): CrawlLinkDecision {
  if (scope.kind === "html-manual-http") {
    return evaluateManualCrawlLink({
      rawLink: scope.pathPrefix ?? "/",
      baseKey: `${scope.origin}/`,
      baseDepth: -1,
      scope,
    });
  }
  return evaluateManualCrawlLink({
    rawLink: scope.entryPath ?? DEFAULT_LOCAL_ENTRY,
    baseKey: "",
    baseDepth: -1,
    scope,
  });
}

function isHtmlContentType(contentType: string | null): boolean {
  if (contentType === null) return true;
  const lower = contentType.toLowerCase();
  return lower.includes("html") || lower.includes("xml") || lower.startsWith("text/plain");
}

// Classify a fetch outcome into either an accepted page or a deny reason. Enforces the
// redirect/content-type/empty-page rules the crawler owns on top of the fetcher's byte cap.
function classifyFetch(
  item: QueueItem,
  result: ManualFetchResult,
): { readonly accepted: CrawledManualPage } | { readonly denied: ManualCrawlDenyReason } {
  if (!result.ok) return { denied: result.reason };
  if (result.redirected === true) return { denied: "redirect" };
  if (result.bytes.length === 0) return { denied: "empty-page" };
  if (!isHtmlContentType(result.contentType)) return { denied: "non-html" };
  return {
    accepted: {
      canonicalKey: item.canonicalKey,
      relativePath: item.relativePath,
      bytes: result.bytes,
      contentType: result.contentType,
      depth: item.depth,
      title: extractManualTitle(result.bytes),
    },
  };
}

function enqueueLinks(
  state: CrawlState,
  deps: ManualCrawlDeps,
  page: CrawledManualPage,
  source: HtmlManualSource,
): void {
  if (page.depth >= source.limits.maxDepth) return;
  const links = extractManualLinks(page.bytes, source.limits.maxLinkSample);
  state.discovered += links.length;
  for (const rawLink of links) {
    enqueueDecision(
      state,
      deps,
      evaluateManualCrawlLink({
        rawLink,
        baseKey: page.canonicalKey,
        baseDepth: page.depth,
        scope: source.scope,
      }),
    );
  }
}

async function processItem(
  state: CrawlState,
  deps: ManualCrawlDeps,
  item: QueueItem,
  source: HtmlManualSource,
): Promise<void> {
  const perPageCap = Math.max(1, source.limits.maxBytes - state.bytesFetched);
  const result = await deps.fetcher.fetchManualPage(item.target, {
    maxBytes: perPageCap,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  state.fetched += 1;
  const classified = classifyFetch(item, result);
  if ("denied" in classified) {
    tallyDeny(state, deps, classified.denied);
    return;
  }
  state.bytesFetched += classified.accepted.bytes.length;
  state.pages.push(classified.accepted);
  deps.onEvent?.({
    kind: "page-accepted",
    relativePath: classified.accepted.relativePath,
    depth: classified.accepted.depth,
  });
  enqueueLinks(state, deps, classified.accepted, source);
}

// True when a governed bound has been hit and the loop must stop accepting new pages.
function budgetExhausted(
  state: CrawlState,
  source: HtmlManualSource,
  deadline: number,
  now: () => number,
): boolean {
  if (state.pages.length >= source.limits.maxPages) return true;
  if (state.bytesFetched >= source.limits.maxBytes) return true;
  return now() >= deadline;
}

function resolveStatus(state: CrawlState, aborted: boolean): ManualCrawlStatus {
  if (aborted) return "cancelled";
  if (state.pages.length === 0) return "empty";
  return state.limitReached ? "limit-reached" : "completed";
}

// Crawl an approved static HTML manual into a bounded page set. Pure orchestration over the injected
// fetcher; keiko-local-knowledge opens no socket itself (ADR-0019 trust-9).
export async function crawlManual(
  deps: ManualCrawlDeps,
  source: HtmlManualSource,
): Promise<ManualCrawlResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + source.limits.timeoutMs;
  const state: CrawlState = {
    queue: [],
    seen: new Set(),
    pages: [],
    denied: new Map(),
    discovered: 0,
    fetched: 0,
    bytesFetched: 0,
    limitReached: false,
  };
  const seed = seedDecision(source.scope);
  enqueueDecision(state, deps, seed);
  let aborted = false;
  while (state.queue.length > 0) {
    if (deps.signal?.aborted === true) {
      aborted = true;
      break;
    }
    if (budgetExhausted(state, source, deadline, now)) {
      state.limitReached = true;
      break;
    }
    const item = state.queue.shift();
    if (item === undefined || item.depth > source.limits.maxDepth) continue;
    await processItem(state, deps, item, source);
  }
  return finalizeCrawl(state, deps, aborted);
}

function finalizeCrawl(
  state: CrawlState,
  deps: ManualCrawlDeps,
  aborted: boolean,
): ManualCrawlResult {
  const status = resolveStatus(state, aborted);
  if (aborted) deps.onEvent?.({ kind: "cancelled" });
  const denied = [...state.denied.entries()].map(([reason, count]) => ({ reason, count }));
  const deniedCount = denied.reduce((sum, entry) => sum + entry.count, 0);
  deps.onEvent?.({ kind: "completed", status, accepted: state.pages.length, deniedCount });
  return {
    status,
    pages: state.pages,
    denied,
    stats: {
      discovered: state.discovered,
      fetched: state.fetched,
      accepted: state.pages.length,
      deniedCount,
      bytesFetched: state.bytesFetched,
    },
  };
}
