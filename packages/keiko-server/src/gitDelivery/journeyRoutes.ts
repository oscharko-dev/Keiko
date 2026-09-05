// Read-only Git delivery journey observation route (#3389 AC5/AC6, epic #3384).
//
//   * POST /api/git-delivery/journey/refresh — READ-ONLY. Reconciles the observed GitHub facts for
//       one accepted draft delivery run's confirmed pull request: canonical PR identity, merged /
//       draft / base / head state, required approvals, unresolved review conversations and the bound
//       issue's actual open/closed state, joined with the existing CI readiness projection and the
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
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type {
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
    stillAuthorized: (): boolean => true,
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

function readinessFor(
  options: GitDeliveryJourneyRouteOptions,
  readiness: ReadinessSnapshot | undefined,
): JourneyObservationOptions["readiness"] {
  return (
    options.readiness ??
    ((): Promise<ReadinessSnapshot | null> => Promise.resolve(readiness ?? null))
  );
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
  if (outcomes === undefined) return true;
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
    readiness: readinessFor(options, ciReadiness),
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

  const subject = confirmedJourneySubject(deps, runId);
  if (subject === undefined) return unavailableResult("draft-unavailable");

  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
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
