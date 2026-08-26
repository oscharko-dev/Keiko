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
import { processServerLogSink } from "../process-log-sink.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { createGatewayManualFetcher } from "./manual-crawl-fetcher.js";

// Terminal jobs are retained so a poll after completion still resolves; the registry is capped so a
// long-lived server cannot accumulate unbounded job records.
export const MAX_RETAINED_JOBS = 64;

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
    // Evict the oldest terminal job first; if none is terminal, every retained slot is still
    // actively running and the oldest one is the fallback victim. Round-3 finding: dropping a
    // still-running victim's registry entry without stopping its work let the crawl/index
    // pipeline keep consuming resources invisibly -- unregistered (so unpollable), with no
    // reachable controller (so uncancellable), and its eventual terminal patch() silently
    // discarded since patch() no-ops on an unknown jobId. Abort the victim's controller first:
    // refreshRun/createRun already pass `signal: controller.signal` into the domain pipeline
    // cooperatively, so this actually stops the work through its normal (fail-closed) lifecycle
    // instead of just forgetting about it.
    const oldestTerminal = [...this.runs.values()].find((run) => run.job.state !== "running");
    const victim = oldestTerminal ?? this.runs.values().next().value;
    if (victim === undefined) return;
    if (victim.job.state === "running") victim.controller.abort();
    this.runs.delete(victim.job.jobId);
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

// A run failure is body-free in the job state and emits one correlation-keyed operator diagnostic.
// The prior pod (refresh) or no pod (create) is left intact by the domain functions. A resolved run
// carries the domain-derived terminal state, so a fail-closed outcome settles as `failed`, not
// `succeeded`.
export async function executeJob(
  jobId: string,
  base: HtmlManualPodJob,
  controller: AbortController,
  run: ManualPodJobRunner,
  diagnostics?: ServerDiagnosticSink,
): Promise<void> {
  let current = base;
  const onCrawlEvent = (event: ManualCrawlEvent): void => {
    current = applyCrawlEvent(current, event);
    manualPodJobRegistry.patch(jobId, current);
  };
  try {
    const { progress, state } = await run(onCrawlEvent);
    manualPodJobRegistry.patch(jobId, projectJob(current, progress, state));
  } catch (error) {
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: jobId,
        operation: "manual-pod.job",
        source: "manual-pod.service",
        error,
        redact: () => "server-operation-failed",
      }),
    );
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

// KEIKO-0647: manual-pod-specific egress resolver, independent of currentGatewayEgressConfig.
// Before this fix the crawler reused the model-gateway's global egress config wholesale, so
// enabling `allowPrivateNetwork` for a model-gateway proxy also opened the SSRF surface for the
// manual HTML crawler. That coupling is wrong: LLM traffic and Manual Pod HTML crawling are
// independent trust boundaries with independent operator-decisions.
//
// The independent resolver INHERITS proxy/CA/other transport settings from the gateway config
// (a corporate deployment already tunes these once), but takes its own `allowPrivateNetwork`
// decision from a manual-pod-specific env var (KEIKO_MANUAL_POD_ALLOW_PRIVATE_NETWORK). The
// default is FALSE -- an intranet manual only reaches private hosts when the operator opts in
// explicitly for the manual-pod surface, never as a side effect of a model-gateway proxy setting.
// This gives no MORE reach than the shared config used to (private-network access still requires
// an explicit opt-in) and does not silently DENY the documented on-prem/intranet use case (the
// operator still has one flag they can turn on).
export function currentManualPodEgressConfig(
  deps: UiHandlerDeps,
): ReturnType<typeof currentGatewayEgressConfig> {
  const base = currentGatewayEgressConfig(deps);
  const allowPrivate = (deps.env.KEIKO_MANUAL_POD_ALLOW_PRIVATE_NETWORK ?? "").trim() === "true";
  if (base === undefined) {
    return allowPrivate ? { allowPrivateNetwork: true } : undefined;
  }
  return { ...base, allowPrivateNetwork: allowPrivate };
}

// Only the HTTP (`html-manual-http`) manual-fetch strategy is wired up here today. The
// domain layer also ships a `html-manual-local` (WorkspaceFs) fetcher in keiko-local-knowledge,
// but no live server route exposes it: neither manual-pod-routes.ts nor the request shapes
// accept a local-root selection input. Keeping the local strategy intentionally-unexposed
// for this release avoids the risk of wiring a filesystem-touching route without the
// route-level authorization equivalent to resolveRegisteredOrManagedWorkspaceRoot and the
// route-level TOCTOU/symlink-escape negative test that the local fetcher's own comments
// require (#2906 KEIKO-0554). See html-manual-source.ts for the matching contract note.
function fetcherFor(deps: UiHandlerDeps): ReturnType<typeof createGatewayManualFetcher> {
  return createGatewayManualFetcher({ egress: () => currentManualPodEgressConfig(deps) });
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
      logSink: processServerLogSink(),
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
        logSink: processServerLogSink(),
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
  diagnostics?: ServerDiagnosticSink,
): HtmlManualPodJob {
  const jobId = randomUUID();
  const controller = new AbortController();
  const base = initialJob(jobId, operation, ids.capsuleId, ids.sourceId);
  manualPodJobRegistry.register(base, controller);
  void executeJob(jobId, base, controller, buildRun(base, controller), diagnostics);
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
    deps.diagnostics,
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
    deps.diagnostics,
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
