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
  type ManualRefreshOutcome,
  type KnowledgeCapsule,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createHtmlManualPod,
  refreshHtmlManualPod,
  type HtmlManualIndexingProgress,
  type ManualCrawlEvent,
  type ManualCrawlFetcher,
} from "@oscharko-dev/keiko-local-knowledge";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";
import { computeManualRootFingerprint } from "../docs-browser-proposal.js";
import { createEmbeddingAdapter, openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import {
  latestRunningJobId,
  resolveNewCapsuleEmbeddingIdentity,
} from "../local-knowledge-handlers.js";
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

// The resolved domain outcome the runner reports back: the progress projection plus the terminal job
// state each operation derived from its own domain result (so a fail-closed refresh/create is never
// reported as `succeeded` merely because the promise resolved).
export interface ManualPodRunOutcome {
  readonly progress: HtmlManualIndexingProgress;
  readonly state: HtmlManualPodJobState;
}

// The one coverage rule both operations settle by, so a create and a refresh can never disagree about
// what "succeeded" means: a usable pod plus a fully covered manual is `succeeded`; a usable pod with
// gaps is `partial` (the domain phase already knows the difference — `ready` vs `degraded`); anything
// that produced nothing usable is `failed`.
function usableTerminalState(
  progress: HtmlManualIndexingProgress,
  usable: boolean,
): HtmlManualPodJobState {
  if (!usable) return "failed";
  return progress.phase === "ready" ? "succeeded" : "partial";
}

// The terminal state for a refresh: nothing usable unless the index-apply path ran (`applied`: a
// completed, non-empty crawl) AND the apply itself did not fail. A not-applied refresh (limit-reached
// / empty / cancelled crawl) leaves the prior pod intact, and an apply that failed outright changed
// nothing — both are `failed`, so the poller never reports a non-applied refresh as a success. An
// applied refresh that left gaps settles `partial`, not `succeeded`.
export function refreshTerminalState(
  applied: boolean,
  outcome: ManualRefreshOutcome,
  progress: HtmlManualIndexingProgress,
): HtmlManualPodJobState {
  return usableTerminalState(progress, applied && outcome !== "failed");
}

// The terminal state for a create: a usable pod requires at least one document's vectors to have been
// persisted (something is searchable). An empty or cancelled crawl (no indexing) or an all-failed
// index persists nothing → `failed`. Vectors persisted but pages of the approved manual skipped or
// failed → `partial`; only a fully covered manual is `succeeded`.
export function createTerminalState(progress: HtmlManualIndexingProgress): HtmlManualPodJobState {
  return usableTerminalState(
    progress,
    progress.indexing !== null && progress.indexing.vectorsPersisted > 0,
  );
}

// A run failure is a body-free failure: the error is dropped and the job goes to state=failed. The
// prior pod (refresh) or no pod (create) is left intact by the domain functions. A resolved run
// carries the domain-derived terminal state, so a fail-closed outcome settles as `failed`, not
// `succeeded`.
export async function executeJob(
  jobId: string,
  base: HtmlManualPodJob,
  controller: AbortController,
  run: ManualPodJobRunner,
): Promise<void> {
  let current = base;
  const onCrawlEvent = (event: ManualCrawlEvent): void => {
    current = applyCrawlEvent(current, event);
    manualPodJobRegistry.patch(jobId, current);
  };
  try {
    const { progress, state } = await run(onCrawlEvent);
    manualPodJobRegistry.patch(jobId, projectJob(current, progress, state));
  } catch {
    manualPodJobRegistry.patch(jobId, failedJob(current));
  }
}

export function buildHttpManualSource(
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
  | {
      readonly ok: false;
      readonly reason: "no-embedding-model" | "invalid-source" | "job-already-running";
    };

// A background job runner: emits crawl events and resolves the domain progress. Injectable so tests
// exercise the start/registry/projection path without a real store, fetcher, or network.
export type ManualPodJobRunner = (
  onCrawlEvent: (event: ManualCrawlEvent) => void,
) => Promise<ManualPodRunOutcome>;

export interface ManualPodJobContext {
  readonly env: DomainEnv;
  readonly fetcher: ManualCrawlFetcher;
}

export interface StartManualPodOverrides {
  // Test seam: a pre-built domain context (real store + adapter + fetcher). Defaults to one resolved
  // from `deps` (configured embedding model required).
  readonly context?: ManualPodJobContext;
  // Test seam: the background run thunk. Defaults to the real create/refresh domain call.
  readonly run?: ManualPodJobRunner;
}

function resolveManualPodContext(deps: UiHandlerDeps): ManualPodJobContext | undefined {
  const env = openManualEnv(deps);
  return env === undefined ? undefined : { env, fetcher: fetcherFor(deps) };
}

function refreshRun(
  ctx: ManualPodJobContext,
  request: HtmlManualPodRefreshRequest,
  controller: AbortController,
): ManualPodJobRunner {
  return (onCrawlEvent): Promise<ManualPodRunOutcome> =>
    refreshHtmlManualPod({
      store: ctx.env.store,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: ctx.env.embeddingAdapter,
      fetcher: ctx.fetcher,
      capsuleId: request.capsuleId as KnowledgeCapsuleId,
      sourceId: request.sourceId as KnowledgeSourceId,
      signal: controller.signal,
      onCrawlEvent,
    })
      .then((result) => ({
        progress: result.progress,
        state: refreshTerminalState(result.applied, result.changeSummary.outcome, result.progress),
      }))
      .finally(() => {
        ctx.env.close();
      });
}

function createRun(
  ctx: ManualPodJobContext,
  source: HtmlManualSource,
  identity: KnowledgeCapsule["embeddingModelIdentity"],
  ids: { readonly capsuleId: string; readonly sourceId: string },
  controller: AbortController,
): ManualPodJobRunner {
  return (onCrawlEvent): Promise<ManualPodRunOutcome> =>
    createHtmlManualPod(
      {
        store: ctx.env.store,
        parserRegistry: createDefaultParserRegistry(),
        embeddingAdapter: ctx.env.embeddingAdapter,
        embeddingModelIdentity: identity,
        fetcher: ctx.fetcher,
        capsuleId: ids.capsuleId as KnowledgeCapsuleId,
        sourceId: ids.sourceId as KnowledgeSourceId,
        signal: controller.signal,
        onCrawlEvent,
      },
      source,
    )
      .then((result) => ({
        progress: result.progress,
        state: createTerminalState(result.progress),
      }))
      .finally(() => {
        ctx.env.close();
      });
}

function startJob(
  operation: "create" | "refresh",
  ids: { capsuleId: string; sourceId: string },
  buildRun: (base: HtmlManualPodJob, controller: AbortController) => ManualPodJobRunner,
): HtmlManualPodJob {
  const jobId = randomUUID();
  const controller = new AbortController();
  const base = initialJob(jobId, operation, ids.capsuleId, ids.sourceId);
  manualPodJobRegistry.register(base, controller);
  void executeJob(jobId, base, controller, buildRun(base, controller));
  return base;
}

// Start a CREATE job: allocate ids, resolve the configured embedding identity, derive the HTTP
// source, and run createHtmlManualPod in the background. Returns the initial running job.
export async function startManualPodCreate(
  deps: UiHandlerDeps,
  request: HtmlManualPodCreateRequest,
  overrides: StartManualPodOverrides & {
    readonly identity?: KnowledgeCapsule["embeddingModelIdentity"];
  } = {},
): Promise<StartManualPodJobResult> {
  const built = buildHttpManualSource(request);
  if (!built.ok) return { ok: false, reason: "invalid-source" };
  const identity = overrides.identity ?? (await resolveIdentityFor(deps));
  if (identity === undefined) return { ok: false, reason: "no-embedding-model" };
  const ctx = overrides.context ?? resolveManualPodContext(deps);
  if (ctx === undefined) return { ok: false, reason: "no-embedding-model" };
  const ids = { capsuleId: randomUUID(), sourceId: randomUUID() };
  const run = overrides.run;
  const job = startJob(
    "create",
    ids,
    (_base, controller) => run ?? createRun(ctx, built.source, identity, ids, controller),
  );
  return { ok: true, job };
}

async function resolveIdentityFor(
  deps: UiHandlerDeps,
): Promise<KnowledgeCapsule["embeddingModelIdentity"] | undefined> {
  const identity = await resolveNewCapsuleEmbeddingIdentity(deps);
  return identity.ok ? identity.identity : undefined;
}

// Start a REFRESH job for an existing capsule/source. Scope is reconstructed inside
// refreshHtmlManualPod from persisted state — the caller supplies only the ids. A missing capsule is
// surfaced as a failed job (refreshHtmlManualPod rejects, executeJob fails closed), not a 404.
export function startManualPodRefresh(
  deps: UiHandlerDeps,
  request: HtmlManualPodRefreshRequest,
  overrides: StartManualPodOverrides = {},
): StartManualPodJobResult {
  const ctx = overrides.context ?? resolveManualPodContext(deps);
  if (ctx === undefined) return { ok: false, reason: "no-embedding-model" };
  // LK-003 (Epic #189): refuse to start a second concurrent indexer for this capsule — the
  // orchestrator persists running jobs under the same capsule_id whether the run started from
  // the manual path or the general reindex/repair path, so a duplicate refresh would race the
  // in-flight one and corrupt the fingerprint baseline (last-writer-wins, no version check). The
  // query is wrapped so a thrown error still closes the store instead of leaking the handle.
  let runningJobId: string | undefined;
  try {
    runningJobId = latestRunningJobId(ctx.env.store, request.capsuleId as KnowledgeCapsuleId);
  } catch (error) {
    ctx.env.close();
    throw error;
  }
  if (runningJobId !== undefined) {
    ctx.env.close();
    return { ok: false, reason: "job-already-running" };
  }
  const run = overrides.run;
  const job = startJob(
    "refresh",
    { capsuleId: request.capsuleId, sourceId: request.sourceId },
    (_base, controller) => run ?? refreshRun(ctx, request, controller),
  );
  return { ok: true, job };
}

function openManualEnv(deps: UiHandlerDeps): DomainEnv | undefined {
  const embeddingAdapter = createEmbeddingAdapter(deps);
  if ("status" in embeddingAdapter) return undefined;
  const store = openStoreForDeps(deps);
  return {
    store: store.store,
    close: (): void => {
      store.close();
    },
    embeddingAdapter,
  };
}

export function getManualPodJob(jobId: string): HtmlManualPodJob | undefined {
  return manualPodJobRegistry.get(jobId);
}
