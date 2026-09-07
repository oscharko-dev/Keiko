// Read-only Git delivery journey observation route (#3389 AC5/AC6, epic #3384).
//
//   * POST /api/git-delivery/journey/refresh — READ-ONLY. Reconciles the observed GitHub facts for
//       one accepted draft delivery run's confirmed pull request: canonical PR identity, merged /
//       draft / base / head state, required approvals, unresolved review conversations and the bound
//       issue's actual open/closed state, joined with a CI readiness observation this route itself
//       renews (the persisted projection is written only while the run is live and expires 60s
//       later, so a settled run's handoff would otherwise report `readiness-stale` forever) and the
//       current PR-description status. Produces a JourneyOutcome or a typed unavailable reason.
//       Never mutates, never grants merge or issue-close authority.
//
// Admitted by the per-checkout GitHub-reader grant alone (`isGitHubIssueReaderAuthorized`, reused
// through `createProductionJourneyReader`), never `gitDeliveryAuthorityGate` — the run-bound mutation
// authority a terminated or recovered run no longer holds. Restart/reopen/refresh therefore keeps
// working without resuming mutation authority (AC6): the accepted draft/PR binding is read from the
// existing durable `coding_runtime_snapshots` row, and the provider read is admitted by the same
// persisted read grant every checkout-scoped read already consults.
//
// Content-free in evidence: only ids, digests, states, reasons and counts leave the observation on
// the activity log (JourneyObservationController); the response body carries the typed JourneyOutcome
// contract, never a raw provider payload.

import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitCiProviderReader } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { describeError } from "../diagnostics-log.js";
import type {
  createProductionJourneyCiReader as ProductionJourneyCiReaderFn,
  createProductionJourneyReader as ProductionJourneyReaderFn,
  resolveJourneyCheckoutRoot as ResolveJourneyCheckoutRootFn,
} from "../coding-runtime/productionDraftDeliveryDependencies.js";
import { hasOnlyAllowedKeys, isPlainObject, readParsedGitDeliveryBody } from "./requestGuards.js";
import {
  JourneyObservationController,
  type JourneyObservationContext,
  type JourneyObservationOptions,
  type JourneyObservationResult,
} from "./journeyObservationService.js";
import type { GitJourneyOutcomeStore } from "./journeyOutcome.js";
import { journeyEvidenceFresh } from "@oscharko-dev/keiko-contracts/runtime/git-journey-freshness";
import { produceCiReadinessSnapshot } from "./ciReadinessSnapshot.js";
import { createPrDescriptionReceiptStore } from "./prDescriptionReceiptStore.js";
import type { PrDescriptionContext } from "./prDescriptionTypes.js";

// ─── Error envelope ─────────────────────────────────────────────────────────────────────────────

type GitDeliveryJourneyErrorCode =
  "GIT_DELIVERY_JOURNEY_BAD_REQUEST" | "GIT_DELIVERY_JOURNEY_PAYLOAD_TOO_LARGE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryJourneyErrorCode, string>> = {
  GIT_DELIVERY_JOURNEY_BAD_REQUEST: "The request body is not a valid journey observation request.",
  GIT_DELIVERY_JOURNEY_PAYLOAD_TOO_LARGE:
    "The journey observation request exceeds the maximum size.",
};

function errResult(status: number, code: GitDeliveryJourneyErrorCode): RouteResult {
  return { status, body: { error: { code, message: SAFE_MESSAGES[code] } } };
}

// ─── Request parsing ────────────────────────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "runId"]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function parseRunId(value: unknown): string | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, TOP_LEVEL_KEYS)) return undefined;
  if (value.schemaVersion !== "1") return undefined;
  const { runId } = value;
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId) ? runId : undefined;
}

function unavailableResult(
  reason: Extract<JourneyObservationResult, { status: "unavailable" }>["reason"],
): RouteResult {
  return {
    status: 200,
    body: { status: "unavailable", reason } satisfies JourneyObservationResult,
  };
}

// ─── Description-status read (#3389 AC9) ───────────────────────────────────────────────────────

/**
 * Reads the current PR-description status through the existing receipt store read hook. Never
 * generates, refines or applies a description — a missing or unreadable receipt is a closed
 * "unavailable" fact (mapped to JourneyOutcome's own "description-unavailable" reason), never a
 * fabricated current state.
 */
function readDescriptionStatus(
  deps: UiHandlerDeps,
  workspace: WorkspaceInfo,
  repository: string,
  prNumber: number,
  correlationId: string,
  stillAuthorized: () => boolean,
): PrDescriptionApplicationStatus | null {
  const store = createPrDescriptionReceiptStore({
    evidenceStore: deps.evidenceStore,
    // Inlined rather than importing `redactEvidenceString` from `../deps.js`: `deps.ts` composes
    // nearly every server subsystem, and pulling any real (non-type) binding from it into a
    // `gitDelivery/*Routes.ts` module reintroduces the exact ESM load-order cycle `routes.ts`
    // already breaks by importing every route group as a TYPE-ONLY dependency of `deps.js`. The
    // guard below is the whole of `redactEvidenceString`'s body.
    redact: (value: string): string => {
      const redacted = deps.redactor(value);
      if (typeof redacted !== "string")
        throw new TypeError("Evidence redactor returned a non-string value.");
      return redacted;
    },
  });
  const context: PrDescriptionContext = {
    workspace,
    repository,
    prNumber,
    accessScope: {},
    // A read-only lookup mints no authority of its own; this digest only satisfies the receipt
    // store's shape guard (a valid 64-hex string) and is never compared against a real authority.
    authorityDigest: sha256Hex(
      canonicalise({ domain: "keiko-journey-description-read-v1", repository, prNumber }),
    ),
    correlationId,
    stillAuthorized,
  };
  const read = store.readStatus(context);
  return read.ok && read.status !== undefined ? read.status : null;
}

function contentFreeReadWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

// ─── Options (test-only override seam, mirrors GitDeliveryPrRouteOptions) ─────────────────────

export interface GitDeliveryJourneyRouteOptions {
  readonly reader?: JourneyObservationOptions["reader"];
  readonly readiness?: JourneyObservationOptions["readiness"];
  /**
   * Test-only override seam for the run-independent CI reader the readiness resolution uses to
   * renew CI facts once the coding run has settled to `succeeded` (mirrors `reader` above).
   * Production composition never sets this — it defaults to `createProductionJourneyCiReader`. A
   * caller that wants to exercise the fresh-read-then-fallback logic under test (rather than
   * bypassing it entirely via the `readiness` override above) supplies a deterministic
   * `GitCiProviderReader` here, without a live network/`gh` call.
   */
  readonly ciReader?: (context: JourneyObservationContext) => GitCiProviderReader | undefined;
  readonly description?: JourneyObservationOptions["description"];
  /**
   * Durable CAS projection (#3389 AC6). Test-only override seam; production composition never sets
   * this — it defaults to `deps.codingRuntimeSnapshotStore.journeyOutcomes`, the SQLite-backed
   * `createGitJourneyOutcomeStore` (journeyOutcome.ts) exposed on the live, durable
   * `coding_runtime_snapshots` database the same way `ciReadiness`/`ciRepairBudget` already are.
   * That makes the route's CAS write durable across a process restart, not merely at the store's
   * own unit level.
   */
  readonly outcomes?: GitJourneyOutcomeStore;
}

/** Production default: the durable projection on the live snapshot store, when one is wired. */
function outcomesFor(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
): GitJourneyOutcomeStore | undefined {
  return options.outcomes ?? deps.codingRuntimeSnapshotStore?.journeyOutcomes;
}

// `../coding-runtime/productionDraftDeliveryDependencies.js` is loaded lazily (never as a top-level
// value import) because `deps.ts` — a real dependency of that module — composes nearly every server
// subsystem, and a `gitDelivery/*Routes.ts` module pulling it in as a static import reintroduces an
// ESM load-order cycle with `routes.ts` (which imports every route group, this one included, before
// any of them has finished initializing). A dynamic import resolves after module graph load has
// settled, so it carries no such ordering risk; Node caches the module after the first call.
interface DraftDeliveryReaderModule {
  readonly createProductionJourneyReader: typeof ProductionJourneyReaderFn;
  readonly createProductionJourneyCiReader: typeof ProductionJourneyCiReaderFn;
  readonly resolveJourneyCheckoutRoot: typeof ResolveJourneyCheckoutRootFn;
}
let draftDeliveryReaderModule: Promise<DraftDeliveryReaderModule> | undefined;
function loadDraftDeliveryReaderModule(): Promise<DraftDeliveryReaderModule> {
  draftDeliveryReaderModule ??= import("../coding-runtime/productionDraftDeliveryDependencies.js");
  return draftDeliveryReaderModule;
}

function readerFor(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  repositoryId: string,
  createReader: typeof ProductionJourneyReaderFn,
): JourneyObservationOptions["reader"] {
  return (
    options.reader ??
    ((context): ReturnType<typeof ProductionJourneyReaderFn> =>
      createReader(deps, {
        repositoryId,
        correlationId: context.correlationId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }))
  );
}

// ─── Readiness renewal (defect: the persisted CI readiness snapshot is written only by the run's
// own in-run CI tool call and expires 60s later, so it can never be renewed once the run has
// settled to `succeeded` and a human reaches the issue-handoff stage). Mirrors the composition
// `prMarkReadyExecution.ts` already uses after a mark-ready transition: a run-independent CI read,
// `produceCiReadinessSnapshot`, then a best-effort durable write through
// `recordPostDeliveryObservation` — but the freshly observed snapshot is always the value this
// observation uses, whether or not the durable write is admitted (e.g. the PR is still a draft; see
// `codingRuntimeCiReadinessStore.ts`'s `postDeliverySubjectMatches`, which durably records a
// post-delivery observation only once the PR is no longer a draft). Falls back to the existing
// cached snapshot ONLY when the fresh read itself fails or is unavailable — never fabricating
// readiness and never widening authority; a genuinely stale or not-ready state still blocks. ───

function ciReaderFor(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  repositoryId: string,
  createCiReader: typeof ProductionJourneyCiReaderFn,
): (context: JourneyObservationContext) => GitCiProviderReader | undefined {
  return (
    options.ciReader ??
    ((context): ReturnType<typeof ProductionJourneyCiReaderFn> =>
      createCiReader(deps, {
        repositoryId,
        correlationId: context.correlationId,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }))
  );
}

function journeyCiTarget(draft: ConfirmedDraftDeliveryRecord): {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly baseBranchName: string;
  readonly headSha: string;
} {
  return {
    ownerAndRepo: draft.binding.repository,
    prExternalId: draft.pullRequest.externalId,
    baseBranchName: draft.binding.baseRef,
    headSha: draft.binding.headSha,
  };
}

/** Best-effort durable write (#3389 AC6 continuity): the returned fresh snapshot is used for THIS
 * observation regardless of whether the write is admitted — see the module comment above. */
function persistJourneyReadiness(
  deps: UiHandlerDeps,
  runId: string,
  correlationId: string,
  snapshot: ReadinessSnapshot,
): void {
  const store = deps.codingRuntimeSnapshotStore?.ciReadiness;
  const recorded = store?.recordPostDeliveryObservation(runId, snapshot) ?? false;
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.journey-readiness.refreshed",
    correlationId,
    level: "info",
    extra: {
      runId,
      state: snapshot.state,
      reason: snapshot.reason,
      recorded,
      store: store === undefined ? "unavailable" : "available",
    },
  });
}

function logJourneyReadinessFallback(
  deps: UiHandlerDeps,
  correlationId: string,
  runId: string,
  reason: "provider-unavailable" | "read-failed",
  error?: unknown,
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.journey-readiness.refreshed",
    correlationId,
    level: "warn",
    ...(error === undefined ? {} : { errorKind: "internal" }),
    extra: {
      runId,
      recorded: false,
      reason,
      ...(error === undefined ? {} : describeError(error)),
    },
  });
}

async function freshJourneyReadiness(
  deps: UiHandlerDeps,
  draft: ConfirmedDraftDeliveryRecord,
  context: JourneyObservationContext,
  resolveCiReader: (context: JourneyObservationContext) => GitCiProviderReader | undefined,
): Promise<ReadinessSnapshot | undefined> {
  const reader = resolveCiReader(context);
  if (reader === undefined) return undefined;
  const facts = await reader.readFacts(journeyCiTarget(draft));
  if (facts.status !== "observed") return undefined;
  const { snapshot } = produceCiReadinessSnapshot(draft, facts, Date.now());
  persistJourneyReadiness(deps, draft.binding.runId, context.correlationId, snapshot);
  memoizeJourneyReadiness(deps, draft.binding.runId, snapshot);
  return snapshot;
}

// The durable store deliberately declines a post-delivery observation while the pull request is
// still a draft (`codingRuntimeCiReadinessStore.ts`), which is exactly the handoff phase this route
// serves — so without a process-local tier every poll of the handoff card would spend a fresh
// provider read (several `gh` calls each, every few seconds) to reproduce a snapshot that is still
// inside its own 60s TTL. Bounded and keyed per deps like `prDescriptionRoutes.ts`'s service cache,
// so it cannot outlive the composition or grow without limit. It is a cache of an OBSERVED value,
// never a substitute for one: nothing is served from it once the TTL has elapsed.
const MAX_MEMOIZED_READINESS = 64;
let readinessMemos = new WeakMap<UiHandlerDeps, Map<string, ReadinessSnapshot>>();

function readinessMemoFor(deps: UiHandlerDeps): Map<string, ReadinessSnapshot> {
  const existing = readinessMemos.get(deps);
  if (existing !== undefined) return existing;
  const created = new Map<string, ReadinessSnapshot>();
  readinessMemos.set(deps, created);
  return created;
}

function memoizeJourneyReadiness(
  deps: UiHandlerDeps,
  runId: string,
  snapshot: ReadinessSnapshot,
): void {
  const memo = readinessMemoFor(deps);
  memo.set(runId, snapshot);
  while (memo.size > MAX_MEMOIZED_READINESS) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** Test-only: drops the process-local readiness memo so one test file's fresh snapshot can never
 * satisfy another's expectation of a fresh provider read. */
export function clearJourneyReadinessMemo(): void {
  readinessMemos = new WeakMap();
}

/** A snapshot still inside its own TTL, observed for the run and head this observation is about, is
 * the answer — re-reading the provider would spend an API call to reproduce a value that is by
 * definition still current. Anything else — expired, or observed for a different run or head —
 * falls through to a fresh read, so the renewal this route owns still happens the moment the
 * evidence stops being current. */
function reusableJourneyReadiness(
  deps: UiHandlerDeps,
  draft: ConfirmedDraftDeliveryRecord,
  cached: ReadinessSnapshot | undefined,
  now: number,
): ReadinessSnapshot | undefined {
  const binding = draft.binding;
  const current = (candidate: ReadinessSnapshot | undefined): boolean =>
    candidate !== undefined &&
    journeyEvidenceFresh(candidate, now) &&
    candidate.runId === binding.runId &&
    candidate.headSha === binding.headSha;
  const memoized = readinessMemoFor(deps).get(binding.runId);
  if (current(memoized)) return memoized;
  return current(cached) ? cached : undefined;
}

async function refreshJourneyReadiness(
  deps: UiHandlerDeps,
  draft: ConfirmedDraftDeliveryRecord,
  cached: ReadinessSnapshot | undefined,
  context: JourneyObservationContext,
  resolveCiReader: (context: JourneyObservationContext) => GitCiProviderReader | undefined,
): Promise<ReadinessSnapshot | null> {
  const reusable = reusableJourneyReadiness(deps, draft, cached, Date.now());
  if (reusable !== undefined) return reusable;
  const runId = draft.binding.runId;
  try {
    const fresh = await freshJourneyReadiness(deps, draft, context, resolveCiReader);
    if (fresh !== undefined) return fresh;
    logJourneyReadinessFallback(deps, context.correlationId, runId, "provider-unavailable");
  } catch (error) {
    logJourneyReadinessFallback(deps, context.correlationId, runId, "read-failed", error);
  }
  return cached ?? null;
}

function readinessFor(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  repositoryId: string,
  draft: ConfirmedDraftDeliveryRecord,
  cached: ReadinessSnapshot | undefined,
  createCiReader: typeof ProductionJourneyCiReaderFn,
): JourneyObservationOptions["readiness"] {
  if (options.readiness !== undefined) return options.readiness;
  const resolveCiReader = ciReaderFor(deps, options, repositoryId, createCiReader);
  return (context): Promise<ReadinessSnapshot | null> =>
    refreshJourneyReadiness(deps, draft, cached, context, resolveCiReader);
}

function descriptionFor(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  repositoryId: string,
  repository: string,
  prNumber: number,
  resolveCheckoutRoot: typeof ResolveJourneyCheckoutRootFn,
): JourneyObservationOptions["description"] {
  if (options.description !== undefined) return options.description;
  return (context): Promise<PrDescriptionApplicationStatus | null> => {
    const root = resolveCheckoutRoot(deps, repositoryId);
    if (root === undefined) return Promise.resolve(null);
    return Promise.resolve(
      readDescriptionStatus(
        deps,
        contentFreeReadWorkspace(root),
        repository,
        prNumber,
        context.correlationId,
        context.stillAuthorized,
      ),
    );
  };
}

/**
 * CAS write into the durable projection (#3389 AC6), body-free logged so a support timeline can
 * tell a genuinely recorded outcome from one rejected as stale without ever carrying the outcome's
 * own content. `outcomes` is only absent when no `codingRuntimeSnapshotStore` is wired at all (see
 * `outcomesFor`); an absent store never fails the request — the observation still reports its
 * result, it is just not made durable.
 */
function recordJourneyOutcome(
  deps: UiHandlerDeps,
  outcomes: GitJourneyOutcomeStore | undefined,
  correlationId: string,
  outcome: JourneyOutcome,
): boolean {
  if (outcomes === undefined) {
    (deps.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.journey-outcome.recorded",
      correlationId,
      level: "warn",
      extra: {
        runId: outcome.binding.runId,
        state: outcome.state,
        reason: outcome.reason,
        recorded: false,
        store: "unavailable",
      },
    });
    return false;
  }
  const recorded = outcomes.record(outcome);
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.journey-outcome.recorded",
    correlationId,
    level: recorded ? "info" : "warn",
    extra: {
      runId: outcome.binding.runId,
      state: outcome.state,
      reason: outcome.reason,
      recorded,
    },
  });
  return recorded;
}

// ─── Handler ────────────────────────────────────────────────────────────────────────────────────

type ConfirmedDraftDeliveryRecord = Omit<DraftDeliveryRecord, "pullRequest"> & {
  readonly pullRequest: NonNullable<DraftDeliveryRecord["pullRequest"]>;
};

function journeyContext(
  draft: ConfirmedDraftDeliveryRecord,
  correlationId: string,
  reader: JourneyObservationOptions["reader"],
): JourneyObservationContext {
  const context: JourneyObservationContext = {
    draft,
    accessScope: {},
    correlationId,
    stillAuthorized: (): boolean => reader(context) !== undefined,
  };
  return context;
}

function buildJourneyObservationOptions(
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  repositoryId: string,
  draft: ConfirmedDraftDeliveryRecord,
  ciReadiness: ReadinessSnapshot | undefined,
  correlationId: string,
  draftDelivery: DraftDeliveryReaderModule,
): JourneyObservationOptions {
  const reader = readerFor(
    deps,
    options,
    repositoryId,
    draftDelivery.createProductionJourneyReader,
  );
  const context = journeyContext(draft, correlationId, reader);
  return {
    context: () => context,
    reader,
    readiness: readinessFor(
      deps,
      options,
      repositoryId,
      draft,
      ciReadiness,
      draftDelivery.createProductionJourneyCiReader,
    ),
    description: descriptionFor(
      deps,
      options,
      repositoryId,
      draft.binding.repository,
      draft.pullRequest.number,
      draftDelivery.resolveJourneyCheckoutRoot,
    ),
    recordOutcome: (observeContext, outcome): boolean =>
      recordJourneyOutcome(deps, outcomesFor(deps, options), observeContext.correlationId, outcome),
    ...(deps.activityLog === undefined ? {} : { activityLog: deps.activityLog }),
  };
}

interface ConfirmedJourneySubject {
  readonly draft: ConfirmedDraftDeliveryRecord;
  readonly repositoryId: string;
  readonly ciReadiness: ReadinessSnapshot | undefined;
}

/** The persisted, run-independent facts a journey observation needs: the confirmed accepted draft
 * PR and the checkout identity to admit reads against — read straight from the durable
 * `coding_runtime_snapshots` row, so this resolves the same after the originating run terminates. */
function confirmedJourneySubject(
  deps: UiHandlerDeps,
  runId: string,
): ConfirmedJourneySubject | undefined {
  const snapshot = deps.codingRuntimeSnapshotStore?.get(runId);
  const draft = snapshot?.draftDelivery;
  const issueBinding = snapshot?.issueBinding;
  if (snapshot === undefined || draft?.pullRequest === undefined || issueBinding === undefined) {
    return undefined;
  }
  return {
    draft: draft as ConfirmedDraftDeliveryRecord,
    repositoryId: issueBinding.repositoryId,
    ciReadiness: snapshot.ciReadiness,
  };
}

// Owner audit finding b2-9: `JourneyObservationController` is built fresh per request (its
// per-request `correlationId`/CI-readiness snapshot legitimately differ call to call, so a single
// long-lived instance with frozen `options` cannot serve every request correctly), so the
// controller's own `this.active` in-flight guard can never see two overlapping calls for the same
// run and never fires in production. This module-scoped set is the per-run mutex
// `productionCiObservationRuntime.ts` gets from binding one persistent object per accepted run
// (there, the CI observation service itself IS long-lived); enforced here at the route layer,
// keyed by the same runId the controller's draft binding is scoped to, a double-click or retried
// refresh for one run never dispatches two concurrent provider observations.
const activeJourneyRefreshRuns = new Set<string>();

// Owner audit finding b3-20: a request that never reaches the controller (an unbound run, or a
// refresh already in flight for this run) still ran an operation and must leave a body-free
// activity-log line, on the observation op the controller itself uses for every other terminal
// phase — never a silent early return.
function logJourneyRefreshUnavailable(
  deps: UiHandlerDeps,
  correlationId: string,
  runId: string,
  reason: "draft-unavailable" | "observation-in-flight",
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.journey-observation",
    correlationId,
    level: "warn",
    extra: { phase: "unavailable", runId, reason },
  });
}

async function observeJourney(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
  runId: string,
  correlationId: string,
  subject: ConfirmedJourneySubject,
): Promise<RouteResult> {
  activeJourneyRefreshRuns.add(runId);
  try {
    const draftDelivery = await loadDraftDeliveryReaderModule();
    const observationOptions = buildJourneyObservationOptions(
      deps,
      options,
      subject.repositoryId,
      subject.draft,
      subject.ciReadiness,
      correlationId,
      draftDelivery,
    );
    const result = await new JourneyObservationController(observationOptions).observe();
    return { status: 200, body: result };
  } finally {
    activeJourneyRefreshRuns.delete(runId);
  }
}

async function handleJourneyRefresh(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: GitDeliveryJourneyRouteOptions,
): Promise<RouteResult> {
  const parsed = await readParsedGitDeliveryBody(
    ctx.req,
    () => errResult(413, "GIT_DELIVERY_JOURNEY_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_DELIVERY_JOURNEY_BAD_REQUEST"),
  );
  if (!parsed.ok) return parsed.result;
  const runId = parseRunId(parsed.value);
  if (runId === undefined) return errResult(400, "GIT_DELIVERY_JOURNEY_BAD_REQUEST");
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;

  if (activeJourneyRefreshRuns.has(runId)) {
    logJourneyRefreshUnavailable(deps, correlationId, runId, "observation-in-flight");
    return unavailableResult("observation-in-flight");
  }
  const subject = confirmedJourneySubject(deps, runId);
  if (subject === undefined) {
    logJourneyRefreshUnavailable(deps, correlationId, runId, "draft-unavailable");
    return unavailableResult("draft-unavailable");
  }
  return observeJourney(ctx, deps, options, runId, correlationId, subject);
}

// ─── Route group ────────────────────────────────────────────────────────────────────────────────

const createHandleJourneyRefresh = (
  options: GitDeliveryJourneyRouteOptions,
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return (ctx, deps) => handleJourneyRefresh(ctx, deps, options);
};

export const createGitDeliveryJourneyRouteGroup = (
  options: GitDeliveryJourneyRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/journey/refresh",
    handler: createHandleJourneyRefresh(options),
  },
];

export const GIT_DELIVERY_JOURNEY_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryJourneyRouteGroup();
