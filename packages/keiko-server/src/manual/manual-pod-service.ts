// In-process create/refresh job service for HTML Manual Knowledge Pods (Issue #2063).
//
// Wires the UI-triggered live path to the already-audited domain functions: it runs
// `createHtmlManualPod` / `refreshHtmlManualPod` (keiko-local-knowledge) as a bounded background job
// through the `gatewayFetch`-backed HTTP ManualCrawlFetcher, mounting through the SAME
// `runIndexingJob` pipeline as filesystem and connector sources (no parallel indexing path). Crawl
// bounds, the fail-closed scope guard, and evidence redaction are unchanged from Epic #1856 — this
// service only supplies the live entry point and projects the body-free `HtmlManualIndexingProgress`
// onto the wire `HtmlManualPodJob` the UI polls. Every progress value is a count/status/generic
// remediation — never a raw URL, page path, or page body.

import { randomUUID } from "node:crypto";
import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  validateHtmlManualSource,
  type HtmlManualPodCreateRequest,
  type HtmlManualPodJob,
  type HtmlManualPodJobOperation,
  type HtmlManualPodJobState,
  type HtmlManualPodRefreshRequest,
  type HtmlManualSource,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createHtmlManualPod,
  getCapsule,
  refreshHtmlManualPod,
  type HtmlManualIndexingProgress,
  type ManualCrawlEvent,
} from "@oscharko-dev/keiko-local-knowledge";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";
import { computeManualRootFingerprint } from "../docs-browser-proposal.js";
import { createEmbeddingAdapter, openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import { resolveNewCapsuleEmbeddingIdentity } from "../local-knowledge-handlers.js";
import { currentGatewayEgressConfig, type UiHandlerDeps } from "../deps.js";
import { createGatewayManualFetcher } from "./manual-crawl-fetcher.js";

// Terminal jobs are retained so a poll after completion still resolves; the registry is capped so a
// long-lived server cannot accumulate unbounded job records.
const MAX_RETAINED_JOBS = 64;

interface ManualPodJobRun {
  job: HtmlManualPodJob;
  readonly controller: AbortController;
}

export class ManualPodJobRegistry {
  private readonly runs = new Map<string, ManualPodJobRun>();

  register(job: HtmlManualPodJob, controller: AbortController): void {
    this.evictIfFull();
    this.runs.set(job.jobId, { job, controller });
  }

  patch(jobId: string, next: HtmlManualPodJob): void {
    const run = this.runs.get(jobId);
    if (run !== undefined) {
      run.job = next;
    }
  }

  get(jobId: string): HtmlManualPodJob | undefined {
    return this.runs.get(jobId)?.job;
  }

  private evictIfFull(): void {
    if (this.runs.size < MAX_RETAINED_JOBS) return;
    // Evict the oldest terminal job first; if none is terminal, evict the oldest entry.
    const oldestTerminal = [...this.runs.values()].find((run) => run.job.state !== "running");
    const victim = oldestTerminal ?? this.runs.values().next().value;
    if (victim !== undefined) this.runs.delete(victim.job.jobId);
  }
}

export const manualPodJobRegistry = new ManualPodJobRegistry();

function nowMs(): number {
  return Date.now();
}

export function initialJob(
  jobId: string,
  operation: HtmlManualPodJobOperation,
  capsuleId: string,
  sourceId: string,
): HtmlManualPodJob {
  const started = nowMs();
  return {
    schemaVersion: "1",
    jobId,
    operation,
    state: "running",
    phase: "crawling",
    capsuleId,
    sourceId,
    crawl: { discovered: 0, accepted: 0, deniedCount: 0, bytesFetched: 0 },
    indexing: null,
    remediations: [],
    startedAt: started,
    updatedAt: started,
  };
}

// Project the domain progress onto the wire job, stamping the terminal state.
export function projectJob(
  base: HtmlManualPodJob,
  progress: HtmlManualIndexingProgress,
  state: HtmlManualPodJobState,
): HtmlManualPodJob {
  return {
    ...base,
    state,
    phase: progress.phase,
    crawl: {
      discovered: progress.crawl.discovered,
      accepted: progress.crawl.accepted,
      deniedCount: progress.crawl.deniedCount,
      bytesFetched: progress.crawl.bytesFetched,
    },
    indexing:
      progress.indexing === null
        ? null
        : {
            totalDocuments: progress.indexing.totalDocuments,
            processedDocuments: progress.indexing.processedDocuments,
            failedDocuments: progress.indexing.failedDocuments,
            skippedDocuments: progress.indexing.skippedDocuments,
            vectorsPersisted: progress.indexing.vectorsPersisted,
          },
    remediations: progress.remediations.map((r) => ({ reason: r.reason, guidance: r.guidance })),
    updatedAt: nowMs(),
  };
}

// Coarse live-progress: tick accepted/denied counts as the crawl emits events so the UI shows
// movement before the final projection lands. Body-free (event carries counts/reason only).
export function applyCrawlEvent(job: HtmlManualPodJob, event: ManualCrawlEvent): HtmlManualPodJob {
  if (event.kind === "page-accepted") {
    return {
      ...job,
      crawl: { ...job.crawl, accepted: job.crawl.accepted + 1 },
      updatedAt: nowMs(),
    };
  }
  if (event.kind === "link-denied") {
    return {
      ...job,
      crawl: { ...job.crawl, deniedCount: job.crawl.deniedCount + 1 },
      updatedAt: nowMs(),
    };
  }
  return job;
}

function failedJob(base: HtmlManualPodJob): HtmlManualPodJob {
  return { ...base, state: "failed", phase: "degraded", updatedAt: nowMs() };
}

interface DomainEnv {
  readonly store: ReturnType<typeof openStoreForDeps>["store"];
  readonly close: () => void;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
}

// A run failure is a body-free failure: the error is dropped and the job goes to state=failed. The
// prior pod (refresh) or no pod (create) is left intact by the domain functions.
async function executeJob(
  jobId: string,
  base: HtmlManualPodJob,
  controller: AbortController,
  run: (onCrawlEvent: (event: ManualCrawlEvent) => void) => Promise<HtmlManualIndexingProgress>,
): Promise<void> {
  let current = base;
  const onCrawlEvent = (event: ManualCrawlEvent): void => {
    current = applyCrawlEvent(current, event);
    manualPodJobRegistry.patch(jobId, current);
  };
  try {
    const progress = await run(onCrawlEvent);
    manualPodJobRegistry.patch(jobId, projectJob(current, progress, "succeeded"));
  } catch {
    manualPodJobRegistry.patch(jobId, failedJob(current));
  }
}

function buildHttpManualSource(
  request: HtmlManualPodCreateRequest,
): { readonly ok: true; readonly source: HtmlManualSource } | { readonly ok: false } {
  const fingerprint = computeManualRootFingerprint(`${request.origin}${request.pathPrefix ?? ""}`);
  if (fingerprint === null) return { ok: false };
  const source: HtmlManualSource = {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: request.origin, pathPrefix: request.pathPrefix },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: fingerprint,
    proposedPodName: request.displayName,
  };
  return validateHtmlManualSource(source).ok ? { ok: true, source } : { ok: false };
}

function fetcherFor(deps: UiHandlerDeps): ReturnType<typeof createGatewayManualFetcher> {
  return createGatewayManualFetcher({ egress: () => currentGatewayEgressConfig(deps) });
}

export type StartManualPodJobResult =
  | { readonly ok: true; readonly job: HtmlManualPodJob }
  | { readonly ok: false; readonly reason: "no-embedding-model" | "invalid-source" | "not-found" };

// Start a CREATE job: allocate ids, resolve the configured embedding identity, derive the HTTP
// source, and run createHtmlManualPod in the background. Returns the initial running job.
export async function startManualPodCreate(
  deps: UiHandlerDeps,
  request: HtmlManualPodCreateRequest,
): Promise<StartManualPodJobResult> {
  const identity = await resolveNewCapsuleEmbeddingIdentity(deps);
  if (!identity.ok) return { ok: false, reason: "no-embedding-model" };
  const built = buildHttpManualSource(request);
  if (!built.ok) return { ok: false, reason: "invalid-source" };
  const env = openManualEnv(deps);
  if (env === undefined) return { ok: false, reason: "no-embedding-model" };
  const jobId = randomUUID();
  const capsuleId = randomUUID();
  const sourceId = randomUUID();
  const controller = new AbortController();
  const base = initialJob(jobId, "create", capsuleId, sourceId);
  manualPodJobRegistry.register(base, controller);
  const fetcher = fetcherFor(deps);
  void executeJob(jobId, base, controller, (onCrawlEvent) =>
    createHtmlManualPod(
      {
        store: env.store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: env.embeddingAdapter,
        embeddingModelIdentity: identity.identity,
        fetcher,
        capsuleId: capsuleId as KnowledgeCapsuleId,
        sourceId: sourceId as KnowledgeSourceId,
        signal: controller.signal,
        onCrawlEvent,
      },
      built.source,
    )
      .then((result) => result.progress)
      .finally(() => env.close()),
  );
  return { ok: true, job: base };
}

// Start a REFRESH job for an existing capsule/source. Scope is reconstructed inside
// refreshHtmlManualPod from persisted state — the caller supplies only the ids.
export function startManualPodRefresh(
  deps: UiHandlerDeps,
  request: HtmlManualPodRefreshRequest,
): StartManualPodJobResult {
  const env = openManualEnv(deps);
  if (env === undefined) return { ok: false, reason: "no-embedding-model" };
  if (getCapsule(env.store, request.capsuleId as KnowledgeCapsuleId) === undefined) {
    env.close();
    return { ok: false, reason: "not-found" };
  }
  const jobId = randomUUID();
  const controller = new AbortController();
  const base = initialJob(jobId, "refresh", request.capsuleId, request.sourceId);
  manualPodJobRegistry.register(base, controller);
  const fetcher = fetcherFor(deps);
  void executeJob(jobId, base, controller, (onCrawlEvent) =>
    refreshHtmlManualPod({
      store: env.store,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: env.embeddingAdapter,
      fetcher,
      capsuleId: request.capsuleId as KnowledgeCapsuleId,
      sourceId: request.sourceId as KnowledgeSourceId,
      signal: controller.signal,
      onCrawlEvent,
    })
      .then((result) => result.progress)
      .finally(() => env.close()),
  );
  return { ok: true, job: base };
}

function openManualEnv(deps: UiHandlerDeps): DomainEnv | undefined {
  const embeddingAdapter = createEmbeddingAdapter(deps);
  if ("status" in embeddingAdapter) return undefined;
  const store = openStoreForDeps(deps);
  return { store: store.store, close: store.close, embeddingAdapter };
}

export function getManualPodJob(jobId: string): HtmlManualPodJob | undefined {
  return manualPodJobRegistry.get(jobId);
}
