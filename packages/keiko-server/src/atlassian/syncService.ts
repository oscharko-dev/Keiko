// Atlassian connector sync service (Issues #2242/#2243, Epic #2238, ADR-0128 D1/D5).
//
// keiko-server is the sole composition root for the sync lane: this service resolves the
// credential metadata, builds the gatewayFetch-backed bounded-body transport, runs the
// provider-agnostic fetch lane from keiko-connectors (Confluence #2242 and Jira #2243 plug into
// the SAME lane through `runProviderFetch`), and feeds the outcome into the keiko-local-knowledge
// connector-pod sink (shared parser/chunking/indexing pipeline).
//
// Jira incremental re-sync (#2243): when the persisted scope carries a provider watermark from a
// previous APPLIED run, the Jira source narrows its fetch set by `updated >= watermark - overlap`
// against the persisted fingerprint-baseline keys; the enumeration snapshot reports the carried
// (unchanged, not re-fetched) keys plus the run's new watermark, and both flow into the sink so
// carried items stay indexed, diff as unchanged, and the watermark only ever advances
// monotonically on applied runs. Scope is reconstructed from persisted approved state ONLY — the
// stored projectKeys/JQL are the run's scope by construction, so JQL drift on re-sync is
// impossible.
//
// Job model: explicit, user-triggered runs tracked in an in-process registry (the same
// poll-with-cancel convention the memory-consolidation jobs use). Job state is the #2240
// `AtlassianSyncJobState` contract — counts, closed reason codes, and the redacted change
// summary; no page/issue body, URL, JQL text, or upstream error text can enter it. Every run
// additionally produces exactly one content-free `AtlassianConnectorActivityRecord` (ADR-0128
// D6), retained in a bounded in-memory ring per BFF process.

import { randomUUID } from "node:crypto";
import {
  createConfluenceSyncSource,
  createJiraSyncSource,
  laterJiraProviderTimestamp,
  runAtlassianSyncFetch,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianSyncFetchOutcome,
  type AtlassianSyncItem,
  type JiraIncrementalSyncOptions,
  type JiraSyncEnumerationSnapshot,
} from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX,
  ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type AtlassianConnectorActionDisposition,
  type AtlassianConnectorActivityOutcome,
  type AtlassianConnectorActivityReasonCode,
  type AtlassianConnectorActivityRecord,
  type AtlassianConnectorProvider,
  type AtlassianSyncChangeSummary,
  type AtlassianSyncFailureReason,
  type AtlassianSyncJobState,
  type AtlassianSyncProgressCounts,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  applyConnectorSyncRun,
  createConnectorPodShell,
  createDefaultParserRegistry,
  getCapsule,
  readConnectorItemFingerprints,
  recordUnappliedConnectorSyncRun,
  requireConnectorSourceMetadata,
  type ConnectorSourceMetadata,
  type ConnectorSyncApplyResult,
  type ConnectorSyncContentItem,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "../deps.js";
import { openKnowledgeStoreForDeps } from "../local-knowledge-store-open.js";
import {
  configuredProviderForCapsule,
  localKnowledgeEmbeddingAdapterForProvider,
  resolveNewCapsuleEmbeddingIdentity,
} from "../local-knowledge-handlers.js";

const ACTIVITY_RING_LIMIT = 200;

// The connector identity a pod is keyed by: derived from the credential's opaque authRef so it is
// stable across credential ROTATION (vault.set on the same reference) yet never a display name or
// URL. The `cred-` prefix keeps it inside the contracts' safe-identifier alphabet.
export function connectorIdForAuthRef(authRef: string): string {
  return `cred-${authRef.slice(ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX.length)}`;
}

// One deterministic source id per connector capsule (a connector pod has exactly one source).
export function connectorSourceIdFor(capsuleId: KnowledgeCapsuleId): KnowledgeSourceId {
  return `${String(capsuleId)}-source` as KnowledgeSourceId;
}

// ─── Typed request failures (expected 4xx; unexpected faults rethrow to the top-level catch) ──
export class AtlassianSyncRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AtlassianSyncRequestError";
    this.status = status;
    this.code = code;
  }
}

// ─── Governance rationale (Issue #2244, ADR-0128 D4) ──────────────────────────
// How this run was admitted, recorded on its terminal activity record. A direct human-triggered
// BFF start is human-approved by construction (ADR-0129 human-control invariant; ADR-0128 D5
// explicit user-triggered sync) and records `allowed` + `human-initiated`; an agent-initiated
// start under an Authority Envelope records the D4 disposition the policy seam derived
// (`allowed` when the mode admits it, `review-required` + the review reason when a human
// approved the pending action).
export interface AtlassianSyncGovernance {
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly reasonCode?: AtlassianConnectorActivityReasonCode | undefined;
}

export const HUMAN_INITIATED_SYNC_GOVERNANCE: AtlassianSyncGovernance = Object.freeze({
  disposition: "allowed",
  reasonCode: ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON,
});

// ─── Job registry ──────────────────────────────────────────────────────────────
interface MutableSyncJob {
  readonly jobId: string;
  readonly authRef: string;
  readonly connectorId: string;
  readonly provider: AtlassianConnectorProvider;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly controller: AbortController;
  readonly queuedAt: number;
  readonly governance: AtlassianSyncGovernance;
  startedAt?: number | undefined;
  state: AtlassianSyncJobState;
}

export class AtlassianSyncJobRegistry {
  private readonly jobs = new Map<string, MutableSyncJob>();
  private readonly activity: AtlassianConnectorActivityRecord[] = [];

  register(job: MutableSyncJob): void {
    this.jobs.set(job.jobId, job);
  }

  get(jobId: string): MutableSyncJob | undefined {
    return this.jobs.get(jobId);
  }

  hasActiveRunForCapsule(capsuleId: string): boolean {
    for (const job of this.jobs.values()) {
      if (String(job.capsuleId) !== capsuleId) continue;
      if (job.state.status === "pending" || job.state.status === "running") return true;
    }
    return false;
  }

  cancel(jobId: string): MutableSyncJob | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    job.controller.abort();
    return job;
  }

  recordActivity(record: AtlassianConnectorActivityRecord): void {
    this.activity.push(record);
    if (this.activity.length > ACTIVITY_RING_LIMIT) {
      this.activity.splice(0, this.activity.length - ACTIVITY_RING_LIMIT);
    }
  }

  listActivity(connectorId: string): readonly AtlassianConnectorActivityRecord[] {
    return this.activity.filter((record) => record.connectorId === connectorId);
  }

  reset(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    this.activity.length = 0;
  }
}

export const atlassianSyncJobRegistry = new AtlassianSyncJobRegistry();

// ─── Job state projection ──────────────────────────────────────────────────────
type JobCommonFields = Pick<
  AtlassianSyncJobState,
  "schemaVersion" | "jobId" | "connectorId" | "provider" | "queuedAt" | "progress"
>;

function jobCommon(job: MutableSyncJob, progress: AtlassianSyncProgressCounts): JobCommonFields {
  return {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    jobId: job.jobId,
    connectorId: job.connectorId,
    provider: job.provider,
    queuedAt: job.queuedAt,
    progress,
  };
}

function zeroProgress(): AtlassianSyncProgressCounts {
  return {
    enumeratedItems: 0,
    fetchedItems: 0,
    indexedItems: 0,
    skippedItems: 0,
    failedItems: 0,
  };
}

function terminalJobState(
  job: MutableSyncJob,
  progress: AtlassianSyncProgressCounts,
  summary: AtlassianSyncChangeSummary,
  failureReasons: readonly AtlassianSyncFailureReason[],
  now: number,
): AtlassianSyncJobState {
  const common = jobCommon(job, progress);
  const startedAt = job.startedAt;
  switch (summary.outcome) {
    case "succeeded":
      return {
        ...common,
        status: "succeeded",
        startedAt: startedAt ?? now,
        completedAt: now,
        changeSummary: summary,
      };
    case "partial":
      return {
        ...common,
        status: "partial",
        startedAt: startedAt ?? now,
        completedAt: now,
        changeSummary: summary,
        failureReasons,
      };
    case "cancelled":
      return {
        ...common,
        status: "cancelled",
        ...(startedAt !== undefined ? { startedAt } : {}),
        completedAt: now,
        changeSummary: summary,
      };
    case "failed":
      return {
        ...common,
        status: "failed",
        ...(startedAt !== undefined ? { startedAt } : {}),
        completedAt: now,
        failureReason: failureReasons[0] ?? "unavailable",
        changeSummary: summary,
      };
  }
}

// ─── Sync start ────────────────────────────────────────────────────────────────
export interface StartAtlassianSyncInput {
  readonly credential: AtlassianCredentialMetadata;
  // Initial Confluence sync: the explicit, user-selected space keys.
  readonly spaceKeys?: readonly string[] | undefined;
  // Initial Jira sync: the explicit, user-selected project keys plus optional opaque JQL
  // narrowing (#2240 JiraSyncScope; bounded, never logged, never in evidence).
  readonly projectKeys?: readonly string[] | undefined;
  readonly jql?: string | undefined;
  readonly displayName?: string | undefined;
  // Re-sync: the existing connector pod. Scope is reconstructed from persisted approved state
  // ONLY (never widened from the request).
  readonly capsuleId?: KnowledgeCapsuleId | undefined;
  // How this run was admitted (Issue #2244). Absent means a direct human-triggered BFF call,
  // which is human-approved by construction and records `allowed` + `human-initiated`.
  readonly governance?: AtlassianSyncGovernance | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartAtlassianSyncResult {
  readonly job: AtlassianSyncJobState;
  readonly capsuleId: KnowledgeCapsuleId;
}

interface PreparedSyncTarget {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly metadata: ConnectorSourceMetadata;
  // Jira incremental narrowing input (#2243): present only for a re-sync of a jira pod whose
  // previous applied run persisted a provider watermark. Read here, while the store is open,
  // because exactly one run per capsule can be active (registry guard below).
  readonly jiraIncremental?: JiraIncrementalSyncOptions | undefined;
}

function jiraIncrementalFor(
  store: KnowledgeStore,
  metadata: ConnectorSourceMetadata,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): JiraIncrementalSyncOptions | undefined {
  if (metadata.provider !== "jira" || metadata.providerWatermark === undefined) return undefined;
  return {
    providerWatermark: metadata.providerWatermark,
    knownItemKeys: [...readConnectorItemFingerprints(store, capsuleId, sourceId).keys()],
  };
}

function prepareResyncTarget(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  credential: AtlassianCredentialMetadata,
): PreparedSyncTarget {
  const sourceId = connectorSourceIdFor(capsuleId);
  const metadata = requireConnectorSourceMetadata(store, capsuleId, sourceId);
  if (metadata.connectorId !== connectorIdForAuthRef(credential.authRef)) {
    throw new AtlassianSyncRequestError(
      409,
      "CONNECTOR_CREDENTIAL_MISMATCH",
      "The connector pod belongs to a different credential.",
    );
  }
  if (metadata.baseUrl !== credential.baseUrl) {
    throw new AtlassianSyncRequestError(
      409,
      "CONNECTOR_BASE_URL_CHANGED",
      "The credential's base URL no longer matches the pod's approved connector scope.",
    );
  }
  const jiraIncremental = jiraIncrementalFor(store, metadata, capsuleId, sourceId);
  return {
    capsuleId,
    sourceId,
    metadata,
    ...(jiraIncremental === undefined ? {} : { jiraIncremental }),
  };
}

// The approved scope for a NEW connector pod: provider decides which explicit user selection
// applies. Only jira carries the optional opaque JQL narrowing.
function initialScope(input: StartAtlassianSyncInput): {
  readonly scopeKeys: readonly string[];
  readonly jql?: string | undefined;
} {
  if (input.credential.provider === "jira") {
    return {
      scopeKeys: input.projectKeys ?? [],
      ...(input.jql === undefined ? {} : { jql: input.jql }),
    };
  }
  return { scopeKeys: input.spaceKeys ?? [] };
}

async function prepareInitialTarget(
  deps: UiHandlerDeps,
  store: KnowledgeStore,
  input: StartAtlassianSyncInput,
): Promise<PreparedSyncTarget> {
  const identity = await resolveNewCapsuleEmbeddingIdentity(deps);
  if (!identity.ok) {
    throw new AtlassianSyncRequestError(
      409,
      "EMBEDDING_UNAVAILABLE",
      "No configured embedding-capable model is available for connector pods.",
    );
  }
  const capsuleId = `connector-pod-${randomUUID()}` as KnowledgeCapsuleId;
  const sourceId = connectorSourceIdFor(capsuleId);
  const now = input.now;
  createConnectorPodShell(
    { store, capsuleId, sourceId, ...(now !== undefined ? { now } : {}) },
    {
      definition: {
        provider: input.credential.provider,
        connectorId: connectorIdForAuthRef(input.credential.authRef),
        baseUrl: input.credential.baseUrl,
        ...initialScope(input),
        bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
      },
      displayName: input.displayName ?? input.credential.displayName,
      embeddingModelIdentity: identity.identity,
    },
  );
  return {
    capsuleId,
    sourceId,
    metadata: requireConnectorSourceMetadata(store, capsuleId, sourceId),
  };
}

// ─── The provider seam (Confluence #2242; Jira #2243) ─────────────────────────
interface ProviderFetchInput {
  readonly metadata: ConnectorSourceMetadata;
  readonly http: AtlassianHttpBodyPort;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly onProgress: (progress: AtlassianSyncProgressCounts) => void;
  readonly jiraIncremental?: JiraIncrementalSyncOptions | undefined;
  readonly onJiraEnumerated?: ((snapshot: JiraSyncEnumerationSnapshot) => void) | undefined;
}

function runProviderFetch(input: ProviderFetchInput): Promise<AtlassianSyncFetchOutcome> {
  if (input.metadata.provider === "confluence") {
    return runAtlassianSyncFetch({
      source: createConfluenceSyncSource({
        baseUrl: input.metadata.baseUrl,
        connectorId: input.metadata.connectorId,
        spaceKeys: input.metadata.scopeKeys,
      }),
      http: input.http,
      bounds: input.metadata.bounds,
      signal: input.signal,
      now: input.now,
      onProgress: input.onProgress,
    });
  }
  // Scope preservation by construction: projectKeys and the opaque JQL come exclusively from the
  // persisted approved metadata — a re-sync request cannot supply, widen, or swap them.
  return runAtlassianSyncFetch({
    source: createJiraSyncSource({
      baseUrl: input.metadata.baseUrl,
      connectorId: input.metadata.connectorId,
      projectKeys: input.metadata.scopeKeys,
      ...(input.metadata.jql === undefined ? {} : { jql: input.metadata.jql }),
      ...(input.jiraIncremental === undefined ? {} : { incremental: input.jiraIncremental }),
      ...(input.onJiraEnumerated === undefined ? {} : { onEnumerated: input.onJiraEnumerated }),
    }),
    http: input.http,
    bounds: input.metadata.bounds,
    signal: input.signal,
    now: input.now,
    onProgress: input.onProgress,
  });
}

// ─── Run execution ─────────────────────────────────────────────────────────────
interface SyncRunContext {
  readonly deps: UiHandlerDeps;
  readonly job: MutableSyncJob;
  readonly httpBodyPort: AtlassianHttpBodyPort;
  readonly metadata: ConnectorSourceMetadata;
  readonly now: () => number;
  readonly jiraIncremental?: JiraIncrementalSyncOptions | undefined;
  // Holder for the Jira enumeration snapshot (carried keys + watermark); written by the adapter's
  // onEnumerated callback during the run and consumed at finalize time.
  readonly enumeration: { snapshot?: JiraSyncEnumerationSnapshot | undefined };
}

function updateRunningProgress(
  context: SyncRunContext,
  progress: AtlassianSyncProgressCounts,
): void {
  context.job.state = {
    ...jobCommon(context.job, progress),
    status: "running",
    startedAt: context.job.startedAt ?? context.now(),
  };
}

function itemsForSink(items: readonly AtlassianSyncItem[]): readonly ConnectorSyncContentItem[] {
  const encoder = new TextEncoder();
  return items.map((item) => ({
    itemKey: item.itemKey,
    relativePath: item.relativePath,
    title: item.title,
    bytes: encoder.encode(item.contentHtml),
    ...(item.webuiPath === undefined ? {} : { webuiPath: item.webuiPath }),
    ...(item.citationMetadataJson === undefined
      ? {}
      : { citationMetadataJson: item.citationMetadataJson }),
  }));
}

type CompletedFetchOutcome = Extract<AtlassianSyncFetchOutcome, { status: "completed" }>;

function partitionFailureKeys(outcome: CompletedFetchOutcome): {
  readonly deniedItemKeys: readonly string[];
  readonly failedItemKeys: readonly string[];
} {
  const denied: string[] = [];
  const failed: string[] = [];
  for (const failure of outcome.failures) {
    (failure.reason === "permission-denied" ? denied : failed).push(failure.itemKey);
  }
  return { deniedItemKeys: denied, failedItemKeys: failed };
}

function failureReasonsOf(outcome: CompletedFetchOutcome): readonly AtlassianSyncFailureReason[] {
  return [...new Set(outcome.failures.map((failure) => failure.reason))];
}

interface FinalizedRun {
  readonly apply: ConnectorSyncApplyResult;
  readonly reason: AtlassianSyncFailureReason | undefined;
}

async function applyCompletedOutcome(
  context: SyncRunContext,
  store: KnowledgeStore,
  outcome: CompletedFetchOutcome,
): Promise<FinalizedRun> {
  const capsule = getCapsule(store, context.job.capsuleId);
  if (capsule === undefined) {
    throw new AtlassianSyncRequestError(
      404,
      "POD_NOT_FOUND",
      "The connector pod no longer exists.",
    );
  }
  const provider = configuredProviderForCapsule(context.deps, capsule);
  if (provider === undefined) {
    throw new AtlassianSyncRequestError(
      409,
      "EMBEDDING_UNAVAILABLE",
      "No configured embedding-capable model is available for connector pods.",
    );
  }
  // Jira (#2243): carried keys re-join the enumerated view inside the sink; the watermark only
  // advances monotonically (never regresses on a re-sync that saw no newer update) and only on
  // applied runs.
  const snapshot = context.enumeration.snapshot;
  const carriedItemKeys = snapshot?.carriedItemKeys ?? [];
  const providerWatermark =
    context.metadata.provider === "jira"
      ? laterJiraProviderTimestamp(context.metadata.providerWatermark, snapshot?.providerWatermark)
      : undefined;
  const apply = await applyConnectorSyncRun(
    {
      store,
      capsuleId: context.job.capsuleId,
      sourceId: context.job.sourceId,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: localKnowledgeEmbeddingAdapterForProvider(context.deps, provider),
      signal: context.job.controller.signal,
      now: context.now,
    },
    {
      runId: context.job.jobId,
      items: itemsForSink(outcome.items),
      enumeratedItemKeys: outcome.enumeratedItemKeys,
      ...partitionFailureKeys(outcome),
      ...(carriedItemKeys.length === 0 ? {} : { carriedItemKeys }),
      ...(providerWatermark === undefined ? {} : { providerWatermark }),
    },
  );
  return { apply, reason: failureReasonsOf(outcome)[0] };
}

function recordUnappliedOutcome(
  context: SyncRunContext,
  store: KnowledgeStore,
  outcome: Exclude<AtlassianSyncFetchOutcome, { status: "completed" }>,
): FinalizedRun {
  const mapping =
    outcome.status === "cancelled"
      ? { outcome: "cancelled" as const, reason: undefined }
      : outcome.status === "truncated"
        ? { outcome: "partial" as const, reason: outcome.reason }
        : { outcome: "failed" as const, reason: outcome.reason };
  const apply = recordUnappliedConnectorSyncRun(
    {
      store,
      capsuleId: context.job.capsuleId,
      sourceId: context.job.sourceId,
      now: context.now,
    },
    {
      runId: context.job.jobId,
      outcome: mapping.outcome,
      ...(mapping.reason === undefined ? {} : { failureReason: mapping.reason }),
    },
  );
  return { apply, reason: mapping.reason };
}

const ACTIVITY_OUTCOME_BY_SUMMARY: Readonly<
  Record<AtlassianSyncChangeSummary["outcome"], AtlassianConnectorActivityOutcome>
> = {
  succeeded: "succeeded",
  partial: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

// The D4 action-type row for a sync run, by provider (`sync-space` is Confluence-only vocabulary;
// Jira runs are `sync-project`).
const SYNC_ACTION_TYPE_BY_PROVIDER: Readonly<
  Record<AtlassianConnectorProvider, "sync-space" | "sync-project">
> = {
  confluence: "sync-space",
  jira: "sync-project",
};

// The record's one reason code (exactly-one-reason rule): a failed run always carries its
// closed failure reason; otherwise the governance rationale (`human-initiated` for direct BFF
// starts, the review reason for approved agent starts) wins over an incidental partial-failure
// reason, which remains fully visible in the change summary and the job state.
function syncActivityReasonCode(
  context: SyncRunContext,
  outcome: AtlassianConnectorActivityOutcome,
  failureReason: AtlassianSyncFailureReason | undefined,
): AtlassianConnectorActivityReasonCode | undefined {
  if (outcome === "failed") return failureReason;
  return context.job.governance.reasonCode ?? failureReason;
}

// Exactly one content-free activity record per run attempt (ADR-0128 D6): identifiers, closed
// reason codes, the redacted change summary, and durations only. The disposition is the
// governance rationale resolved at start time (Issue #2244): `allowed` + `human-initiated` for
// a direct human-triggered start, or the envelope-derived D4 disposition for an agent start.
function recordSyncActivity(
  context: SyncRunContext,
  summary: AtlassianSyncChangeSummary,
  reasonCode: AtlassianSyncFailureReason | undefined,
  completedAt: number,
): void {
  const outcome = ACTIVITY_OUTCOME_BY_SUMMARY[summary.outcome];
  const recordedReason = syncActivityReasonCode(context, outcome, reasonCode);
  atlassianSyncJobRegistry.recordActivity({
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    activityId: randomUUID(),
    occurredAt: completedAt,
    connectorId: context.job.connectorId,
    provider: context.job.provider,
    actionType: SYNC_ACTION_TYPE_BY_PROVIDER[context.job.provider],
    actionClass: "connector-access",
    disposition: context.job.governance.disposition,
    outcome,
    ...(recordedReason === undefined ? {} : { reasonCode: recordedReason }),
    correlationId: context.job.jobId,
    durationMs: Math.max(0, completedAt - (context.job.startedAt ?? context.job.queuedAt)),
    syncSummary: summary,
  });
}

function progressWithIndexing(
  progress: AtlassianSyncProgressCounts,
  apply: ConnectorSyncApplyResult,
): AtlassianSyncProgressCounts {
  return { ...progress, indexedItems: apply.indexing?.processedDocuments ?? 0 };
}

async function finalizeRun(
  context: SyncRunContext,
  outcome: AtlassianSyncFetchOutcome,
): Promise<void> {
  const opened = openKnowledgeStoreForDeps(context.deps, { recover: true });
  try {
    const result =
      outcome.status === "completed"
        ? await applyCompletedOutcome(context, opened.store, outcome)
        : recordUnappliedOutcome(context, opened.store, outcome);
    const completedAt = context.now();
    const failureReasons =
      outcome.status === "completed"
        ? failureReasonsOf(outcome)
        : result.reason === undefined
          ? []
          : [result.reason];
    context.job.state = terminalJobState(
      context.job,
      progressWithIndexing(outcome.progress, result.apply),
      result.apply.changeSummary,
      failureReasons,
      completedAt,
    );
    recordSyncActivity(context, result.apply.changeSummary, result.reason, completedAt);
  } finally {
    opened.close();
  }
}

// Failures of the run machinery itself (store faults, adapter bugs) must never vanish: the job
// terminates as failed/unavailable with a synthetic zero-count summary and one activity record —
// the job registry is the operator-facing diagnostic surface for background sync runs.
function failJobClosed(context: SyncRunContext): void {
  const completedAt = context.now();
  const summary: AtlassianSyncChangeSummary = {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    outcome: "failed",
    counts: {
      addedItems: 0,
      changedItems: 0,
      removedItems: 0,
      unchangedItems: 0,
      failedItems: 0,
      deniedItems: 0,
    },
    fingerprintSetDigest: "0".repeat(64),
    completedAt,
  };
  context.job.state = terminalJobState(
    context.job,
    context.job.state.progress,
    summary,
    ["unavailable"],
    completedAt,
  );
  recordSyncActivity(context, summary, "unavailable", completedAt);
}

async function executeSyncJob(context: SyncRunContext): Promise<void> {
  try {
    context.job.startedAt = context.now();
    updateRunningProgress(context, zeroProgress());
    const outcome = await runProviderFetch({
      metadata: context.metadata,
      http: context.httpBodyPort,
      signal: context.job.controller.signal,
      now: context.now,
      onProgress: (progress) => {
        updateRunningProgress(context, progress);
      },
      ...(context.jiraIncremental === undefined
        ? {}
        : { jiraIncremental: context.jiraIncremental }),
      onJiraEnumerated: (snapshot) => {
        context.enumeration.snapshot = snapshot;
      },
    });
    await finalizeRun(context, outcome);
  } catch {
    failJobClosed(context);
  }
}

function buildPendingJob(
  input: StartAtlassianSyncInput,
  target: PreparedSyncTarget,
  queuedAt: number,
): MutableSyncJob {
  const jobId = randomUUID();
  const pendingState: AtlassianSyncJobState = {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    jobId,
    connectorId: target.metadata.connectorId,
    provider: target.metadata.provider,
    queuedAt,
    progress: zeroProgress(),
    status: "pending",
  };
  return {
    jobId,
    authRef: input.credential.authRef,
    connectorId: target.metadata.connectorId,
    provider: target.metadata.provider,
    capsuleId: target.capsuleId,
    sourceId: target.sourceId,
    controller: new AbortController(),
    queuedAt,
    // A start without explicit governance is a direct human-triggered BFF call (Issue #2244).
    governance: input.governance ?? HUMAN_INITIATED_SYNC_GOVERNANCE,
    state: pendingState,
  };
}

// Start one explicit sync run (initial when scope keys are provided, re-sync when `capsuleId`
// is). Returns the pending job snapshot; execution continues in the background and is observed
// via the status/cancel routes.
export async function startAtlassianSyncJob(
  deps: UiHandlerDeps,
  input: StartAtlassianSyncInput,
  httpBodyPort: AtlassianHttpBodyPort,
): Promise<StartAtlassianSyncResult> {
  const now = input.now ?? ((): number => Date.now());
  const opened = openKnowledgeStoreForDeps(deps, { recover: true });
  let target: PreparedSyncTarget;
  try {
    target =
      input.capsuleId !== undefined
        ? prepareResyncTarget(opened.store, input.capsuleId, input.credential)
        : await prepareInitialTarget(deps, opened.store, input);
  } finally {
    opened.close();
  }
  if (atlassianSyncJobRegistry.hasActiveRunForCapsule(String(target.capsuleId))) {
    throw new AtlassianSyncRequestError(
      409,
      "SYNC_ALREADY_RUNNING",
      "A sync run is already active for this connector pod.",
    );
  }
  const job = buildPendingJob(input, target, now());
  atlassianSyncJobRegistry.register(job);
  const context: SyncRunContext = {
    deps,
    job,
    httpBodyPort,
    metadata: target.metadata,
    now,
    ...(target.jiraIncremental === undefined ? {} : { jiraIncremental: target.jiraIncremental }),
    enumeration: {},
  };
  setImmediate(() => {
    void executeSyncJob(context);
  });
  return { job: job.state, capsuleId: target.capsuleId };
}
