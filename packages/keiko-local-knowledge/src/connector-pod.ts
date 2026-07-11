// Connector-backed Knowledge Pods (Epic #2238, Issue #2242, ADR-0128 D5).
//
// Turns one applied connector sync run into local Knowledge Pod state by REUSING the existing
// machinery end to end — the same shape as the Epic #1853/#1856 HTML-manual pods:
//
//   - fetched items are mounted through `createManualPageWorkspaceFs` under a synthetic root and
//     a `files` scope flows through `runIndexingJob` — the same parser registry (HTML parser for
//     storage-format bodies), chunker, lexical + vector indexing, incremental skip, and pruning a
//     folder or manual source already uses. No second ingestion or retrieval path.
//   - change classification reuses the SHARED fingerprint-diff engine (`fingerprint-diff.ts`,
//     extracted from the #1856 manual refresh) with `detectMoves: false` — provider item ids are
//     stable, so the moved category cannot occur (ADR-0128 D5).
//   - removal detection follows the issue's rule verbatim: the persisted item-key set is compared
//     against the ENUMERATED key set within the approved scope. Items that failed or were denied
//     this run are still enumerated, so they are never misread as removed; a 404'd item was
//     dropped from the enumerated set upstream and therefore counts as removed.
//   - incremental carry-forward (#2243, Jira): a re-fetch-narrowed run passes the
//     enumeration-confirmed-but-unchanged keys as `carriedItemKeys`. Their prior fingerprints
//     join the run's fingerprint view (diffing as unchanged and surviving the baseline replace),
//     their documents stay indexed untouched, and the orchestrator's discovery prune stands down
//     for the run (`retainUndiscoveredDocuments`) because the mounted scope deliberately covers
//     only re-fetched items. Full-fetch runs (Confluence, initial Jira) behave exactly as before.
//
// Commit discipline (ADR-0128 D5): the source scope update, indexing, and fingerprint-baseline
// replacement happen once, at the end of a completed run — `applyConnectorSyncRun` is only called
// for applicable runs. A cancelled/truncated/failed run goes through
// `recordUnappliedConnectorSyncRun` instead, which commits no content and reports zero
// added/changed/removed so it can never be misread as "nothing changed upstream".

import { randomUUID } from "node:crypto";

import {
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  htmlManualReachableFilesScope,
  isKnowledgePodEvidenceSafeText,
  standardPodModelUsePolicy,
  type AtlassianSyncChangeCounts,
  type AtlassianSyncChangeSummary,
  type AtlassianSyncFailureReason,
  type AtlassianSyncTerminalStatus,
  type EmbeddingModelIdentity,
  type KnowledgeCapsuleId,
  type KnowledgePodModelUsePolicy,
  type KnowledgePodSummary,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";

import { createCapsule, getCapsule, updateCapsuleState } from "./capsule-lifecycle.js";
import { createManualPageWorkspaceFs, type CrawledManualPage } from "./crawl/index.js";
import {
  computeConnectorItemFingerprint,
  computeConnectorRunFingerprint,
  readConnectorItemFingerprints,
  replaceConnectorItemFingerprints,
  type ConnectorItemFingerprint,
} from "./connector-item-fingerprints.js";
import {
  persistConnectorSourceMetadata,
  readConnectorSourceMetadata,
  updateConnectorSyncState,
  type ConnectorSourceDefinition,
  type ConnectorSourceMetadata,
} from "./connector-source-metadata.js";
import { documentIdFor } from "./discovery/index.js";
import { deleteDocumentRow } from "./discovery/persist.js";
import { diffFingerprintSets } from "./fingerprint-diff.js";
import { KnowledgeStoreError } from "./errors.js";
import { runIndexingJob, type IndexingEvent, type IndexingResult } from "./indexing/index.js";
import { buildKnowledgePodSummary } from "./knowledge-pods.js";
import type { AuditEventSink } from "./privacy/index.js";
import type { ParserRegistry } from "./parsers/index.js";
import {
  addSourceToCapsule,
  listCapsuleSources,
  updateSourceScopeInCapsule,
} from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

// Synthetic absolute mount root (never touches disk; the in-memory page fs serves the bytes).
const CONNECTOR_VIRTUAL_ROOT_PREFIX = "/keiko-connector-pod";

export interface ConnectorPodDeps {
  readonly store: KnowledgeStore;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly now?: (() => number) | undefined;
  readonly idSource?: (() => string) | undefined;
  readonly auditSink?: AuditEventSink | undefined;
}

export interface ConnectorPodIndexingDeps extends ConnectorPodDeps {
  readonly parserRegistry: ParserRegistry;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  readonly signal?: AbortSignal | undefined;
  readonly onIndexEvent?: ((event: IndexingEvent) => void) | undefined;
}

// One fetched, normalized item as handed over by the sync lane (bytes are the composed HTML
// document; `relativePath` is the id-derived, rename-stable mount path).
export interface ConnectorSyncContentItem {
  readonly itemKey: string;
  readonly relativePath: string;
  readonly title: string;
  readonly bytes: Uint8Array;
  readonly webuiPath?: string | undefined;
  // Adapter-validated, bounded citation-metadata projection (#2243) persisted beside the item
  // fingerprint for citation display — field values and identifiers only, never a body.
  readonly citationMetadataJson?: string | undefined;
}

// ─── Pod shell ─────────────────────────────────────────────────────────────────
export interface CreateConnectorPodShellInput {
  readonly definition: ConnectorSourceDefinition;
  readonly displayName: string;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy | undefined;
}

// Create the connector pod shell: a draft capsule plus the persisted approved sync scope. The
// capsule_sources row (and all content) attaches on the first APPLIED run, so a shell whose
// first sync fails still projects as a draft/unavailable pod with its approved scope intact.
export function createConnectorPodShell(
  deps: ConnectorPodDeps,
  input: CreateConnectorPodShellInput,
): KnowledgePodSummary {
  createCapsule(
    deps.store,
    {
      id: deps.capsuleId,
      displayName: input.displayName,
      tags: [],
      retrievalEffort: "default",
      outputMode: "answers",
      answerGroundingPolicy: "require-citations-or-state-no-evidence",
      // Connector content is workspace knowledge, not sealed-sensitive by default; a caller may
      // pin a sealed policy for a confidential space (mirrors the manual-pod default).
      modelUsePolicy: input.modelUsePolicy ?? standardPodModelUsePolicy(),
      embeddingModelIdentity: input.embeddingModelIdentity,
      lifecycleState: "draft",
      storageReference: `capsules/${deps.capsuleId}`,
    },
    deps.auditSink,
  );
  persistConnectorSourceMetadata(deps.store, deps.capsuleId, deps.sourceId, input.definition);
  return buildConnectorPodSummary(deps.store, deps.capsuleId);
}

function buildConnectorPodSummary(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): KnowledgePodSummary {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) {
    throw new KnowledgeStoreError("connector capsule vanished during sync");
  }
  return buildKnowledgePodSummary(store, capsule);
}

// Reconstruct the approved scope from persisted state ONLY — a sync request can never supply or
// widen the scope (Epic #1856 scope-preservation rule applied to connectors).
export function requireConnectorSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): ConnectorSourceMetadata {
  const metadata = readConnectorSourceMetadata(store, capsuleId, sourceId);
  if (metadata === undefined) {
    throw new KnowledgeStoreError("no approved connector source to sync");
  }
  return metadata;
}

// ─── Applied run ───────────────────────────────────────────────────────────────
export interface ConnectorSyncRunInput {
  readonly runId?: string | undefined;
  readonly items: readonly ConnectorSyncContentItem[];
  // Item keys the run enumerated within the approved scope (404-vanished items excluded by the
  // lane). Removal detection compares the persisted set against this set UNIONED with the
  // carried keys below.
  readonly enumeratedItemKeys: readonly string[];
  // Item-level terminal failures: permission-denied keys count as denied, everything else failed.
  readonly deniedItemKeys: readonly string[];
  readonly failedItemKeys: readonly string[];
  // Incremental re-sync (#2243): enumeration-confirmed item keys whose provider `updated`
  // watermark showed no change, so their content was NOT re-fetched. Their prior fingerprint
  // entries carry forward into the new baseline (they diff as unchanged), their indexed documents
  // stay untouched, and the orchestrator's discovery prune stands down for the run.
  readonly carriedItemKeys?: readonly string[] | undefined;
  // Verbatim provider `updated` watermark observed by this run's complete enumeration. Persisted
  // only when the run applies — an unapplied run can never advance the incremental cutoff.
  readonly providerWatermark?: string | undefined;
}

export interface ConnectorSyncApplyResult {
  readonly changeSummary: AtlassianSyncChangeSummary;
  readonly indexing?: IndexingResult | undefined;
  readonly summary: KnowledgePodSummary;
}

function itemsToPages(items: readonly ConnectorSyncContentItem[]): readonly CrawledManualPage[] {
  return items.map((item) => ({
    canonicalKey: item.itemKey,
    relativePath: item.relativePath,
    bytes: item.bytes,
    contentType: "text/html",
    depth: 0,
    title: item.title,
  }));
}

function itemFingerprints(
  items: readonly ConnectorSyncContentItem[],
): readonly ConnectorItemFingerprint[] {
  return items.map((item) => ({
    itemKey: item.itemKey,
    contentFingerprint: computeConnectorItemFingerprint(item.bytes),
    byteLength: item.bytes.byteLength,
    relativePath: item.relativePath,
    ...(item.webuiPath === undefined ? {} : { webuiPath: item.webuiPath }),
    ...(item.citationMetadataJson === undefined
      ? {}
      : { citationMetadataJson: item.citationMetadataJson }),
  }));
}

// Carried-forward baseline entries for an incremental run: the prior fingerprints of enumerated
// items that were not re-fetched. Only prior-present keys can carry (a carried key without a
// baseline entry is simply absent — the adapter force-fetches such keys next run).
function carriedFingerprintsFrom(
  prior: ReadonlyMap<string, ConnectorItemFingerprint>,
  carriedItemKeys: readonly string[],
): readonly ConnectorItemFingerprint[] {
  return carriedItemKeys
    .map((key) => prior.get(key))
    .filter((item): item is ConnectorItemFingerprint => item !== undefined);
}

function ensureConnectorSourceAttached(
  deps: ConnectorPodDeps,
  displayName: string,
  scope: NonNullable<ReturnType<typeof htmlManualReachableFilesScope>>,
): void {
  const attached = listCapsuleSources(deps.store, deps.capsuleId).some(
    (source) => source.id === deps.sourceId,
  );
  if (attached) {
    updateSourceScopeInCapsule(deps.store, deps.capsuleId, deps.sourceId, scope);
    return;
  }
  addSourceToCapsule(
    deps.store,
    deps.capsuleId,
    { id: deps.sourceId, displayName, tags: [], scope },
    deps.auditSink,
  );
}

interface DrainedConnectorIndexing {
  readonly result: IndexingResult | undefined;
  // Relative paths of documents that hit a `document-failed` event this run — withheld from the
  // fingerprint baseline so the next sync retries them (mirrors manual-pod-refresh).
  readonly failedRelativePaths: ReadonlySet<string>;
}

async function drainConnectorIndexing(
  events: AsyncIterable<IndexingEvent>,
  onEvent?: (event: IndexingEvent) => void,
): Promise<DrainedConnectorIndexing> {
  let result: IndexingResult | undefined;
  const failedRelativePaths = new Set<string>();
  for await (const event of events) {
    onEvent?.(event);
    if (event.kind === "document-failed" && event.relativePath !== undefined) {
      failedRelativePaths.add(event.relativePath);
    }
    if (
      event.kind === "job-completed" ||
      event.kind === "job-failed" ||
      event.kind === "job-cancelled"
    ) {
      result = event.result;
    }
  }
  return { result, failedRelativePaths };
}

function runConnectorIndexing(
  deps: ConnectorPodIndexingDeps,
  rootPath: string,
  items: readonly ConnectorSyncContentItem[],
  retainUndiscoveredDocuments: boolean,
): Promise<DrainedConnectorIndexing> {
  const workspaceFs = createManualPageWorkspaceFs(rootPath, itemsToPages(items));
  const events = runIndexingJob({
    capsuleId: deps.capsuleId,
    sourceIds: [deps.sourceId],
    parserRegistry: deps.parserRegistry,
    workspaceFs,
    embeddingAdapter: deps.embeddingAdapter,
    store: deps.store,
    ...(retainUndiscoveredDocuments ? { retainUndiscoveredDocuments: true } : {}),
    ...(deps.auditSink !== undefined ? { auditSink: deps.auditSink } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.idSource !== undefined ? { idSource: deps.idSource } : {}),
  });
  return drainConnectorIndexing(events, deps.onIndexEvent);
}

// Citations surface `documents.safe_display_name`; discovery derives it from the mount-path
// basename (`98311.html`), so after indexing every synced document is renamed to its provider
// page title (evidence-safe titles only — an unsafe title keeps the neutral basename). Document
// ids are minted from the SCOPE-RELATIVE path, exactly as discovery does (`documentIdFor`).
function applyDocumentTitles(
  deps: ConnectorPodDeps,
  items: readonly ConnectorSyncContentItem[],
): void {
  const update = deps.store._internal.db.prepare(
    "UPDATE documents SET safe_display_name = :title WHERE capsule_id = :capsuleId AND id = :documentId",
  );
  for (const item of items) {
    if (!isKnowledgePodEvidenceSafeText(item.title)) continue;
    const documentId = documentIdFor({
      capsuleId: deps.capsuleId,
      sourceId: deps.sourceId,
      relativePath: item.relativePath,
    });
    update.run({ title: item.title, capsuleId: deps.capsuleId, documentId });
  }
}

// Deterministic pruning of enumeration-confirmed removals: a removed item's document (and its
// chunks/vectors via the same cascade the orchestrator uses) leaves the index even when the
// incremental indexing run had nothing else to do.
function pruneRemovedItems(
  deps: ConnectorPodDeps,
  prior: ReadonlyMap<string, ConnectorItemFingerprint>,
  removedItemKeys: readonly string[],
): void {
  for (const itemKey of removedItemKeys) {
    const priorItem = prior.get(itemKey);
    if (priorItem === undefined) continue;
    const documentId = documentIdFor({
      capsuleId: deps.capsuleId,
      sourceId: deps.sourceId,
      relativePath: priorItem.relativePath,
    });
    deleteDocumentRow(deps.store._internal.db, deps.capsuleId, documentId);
  }
}

function removedKeysWithinScope(
  prior: ReadonlyMap<string, ConnectorItemFingerprint>,
  enumeratedItemKeys: readonly string[],
): readonly string[] {
  const enumerated = new Set(enumeratedItemKeys);
  return [...prior.keys()].filter((key) => !enumerated.has(key));
}

// Carried-mode parity with the full-fetch behavior: an item that failed or was denied THIS run
// drops out of the baseline, so its now-unverifiable document must not linger (on a full-fetch
// run the orchestrator's discovery prune removes it; with that prune standing down, the sink owns
// it). Fetch-level failure keys only — indexing-withheld documents keep their documents, exactly
// as the orchestrator's failed-documents guard preserves them on full-fetch runs.
function fetchFailurePriorKeys(
  prior: ReadonlyMap<string, ConnectorItemFingerprint>,
  input: ConnectorSyncRunInput,
): readonly string[] {
  const failedOrDenied = new Set([...input.deniedItemKeys, ...input.failedItemKeys]);
  return [...prior.keys()].filter((key) => failedOrDenied.has(key));
}

// A document that failed to (re-)index keeps NO baseline entry: otherwise a later sync would see
// its unindexed content as "unchanged" and never retry it (mirrors `pagesToCommitToBaseline` in
// manual-pod-refresh.ts). Indexing events report the same scope-relative path the items carry.
function baselineFingerprints(
  fingerprints: readonly ConnectorItemFingerprint[],
  failedRelativePaths: ReadonlySet<string>,
): readonly ConnectorItemFingerprint[] {
  if (failedRelativePaths.size === 0) return fingerprints;
  return fingerprints.filter((item) => !failedRelativePaths.has(item.relativePath));
}

interface AppliedChangeInputs {
  readonly prior: ReadonlyMap<string, ConnectorItemFingerprint>;
  readonly fingerprints: readonly ConnectorItemFingerprint[];
  readonly removedItemKeys: readonly string[];
  readonly input: ConnectorSyncRunInput;
  readonly indexing: IndexingResult | undefined;
}

function appliedOutcome(changes: AppliedChangeInputs): AtlassianSyncTerminalStatus {
  if (changes.indexing?.status === "cancelled") return "cancelled";
  if (changes.input.items.length > 0 && changes.indexing?.status !== "succeeded") return "failed";
  const counts = appliedCounts(changes);
  return counts.failedItems > 0 || counts.deniedItems > 0 ? "partial" : "succeeded";
}

function appliedCounts(changes: AppliedChangeInputs): AtlassianSyncChangeCounts {
  const priorByKey = new Map<string, string>();
  for (const [key, item] of changes.prior) priorByKey.set(key, item.contentFingerprint);
  const nextByKey = new Map<string, string>();
  for (const item of changes.fingerprints) nextByKey.set(item.itemKey, item.contentFingerprint);
  // Shared diff engine, moves off (stable provider ids). Removals deliberately come from the
  // enumeration comparison, not the raw set difference, so failed/denied items never read as
  // removed.
  const delta = diffFingerprintSets(priorByKey, nextByKey, { detectMoves: false });
  const indexingFailures = changes.indexing?.failedDocuments ?? 0;
  return {
    addedItems: delta.added,
    changedItems: delta.changed,
    removedItems: changes.removedItemKeys.length,
    unchangedItems: delta.unchanged,
    failedItems: changes.input.failedItemKeys.length + indexingFailures,
    deniedItems: changes.input.deniedItemKeys.length,
  };
}

function zeroedCounts(counts: AtlassianSyncChangeCounts): AtlassianSyncChangeCounts {
  return {
    addedItems: 0,
    changedItems: 0,
    removedItems: 0,
    unchangedItems: counts.unchangedItems,
    failedItems: counts.failedItems,
    deniedItems: counts.deniedItems,
  };
}

function changeSummaryFor(
  outcome: AtlassianSyncTerminalStatus,
  counts: AtlassianSyncChangeCounts,
  persistedSet: readonly ConnectorItemFingerprint[],
  completedAt: number,
): AtlassianSyncChangeSummary {
  const applied = outcome === "succeeded" || outcome === "partial";
  return {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    outcome,
    counts: applied ? counts : zeroedCounts(counts),
    fingerprintSetDigest: computeConnectorRunFingerprint(persistedSet),
    completedAt,
  };
}

function persistTerminalSyncState(
  deps: ConnectorPodDeps,
  runId: string,
  summary: AtlassianSyncChangeSummary,
  failureReason: AtlassianSyncFailureReason | undefined,
  providerWatermark?: string,
): void {
  updateConnectorSyncState(deps.store, deps.capsuleId, deps.sourceId, {
    lastSyncAt: summary.completedAt,
    lastSyncRunId: runId,
    lastSyncStatus: summary.outcome,
    ...(failureReason === undefined ? {} : { lastFailureReason: failureReason }),
    changeSummaryJson: JSON.stringify(summary),
    ...(providerWatermark === undefined ? {} : { providerWatermark }),
  });
}

function appliedFailureReason(
  changes: AppliedChangeInputs,
): AtlassianSyncFailureReason | undefined {
  if (changes.input.deniedItemKeys.length > 0 && changes.input.failedItemKeys.length === 0) {
    return "permission-denied";
  }
  if (changes.input.failedItemKeys.length > 0) return "unavailable";
  return undefined;
}

interface AppliedRunArtifacts {
  readonly indexing: IndexingResult | undefined;
  readonly failedRelativePaths: ReadonlySet<string>;
}

// Applied-run commit: prune enumeration-confirmed removals (plus, in carried mode, this run's
// fetch failures — see fetchFailurePriorKeys), then atomically replace the fingerprint baseline.
function persistAppliedBaseline(
  deps: ConnectorPodDeps,
  changes: AppliedChangeInputs,
  artifacts: AppliedRunArtifacts,
  runId: string,
  carriedMode: boolean,
): readonly ConnectorItemFingerprint[] {
  pruneRemovedItems(deps, changes.prior, changes.removedItemKeys);
  if (carriedMode) {
    pruneRemovedItems(deps, changes.prior, fetchFailurePriorKeys(changes.prior, changes.input));
  }
  const persistedSet = baselineFingerprints(changes.fingerprints, artifacts.failedRelativePaths);
  replaceConnectorItemFingerprints(deps.store, deps.capsuleId, deps.sourceId, persistedSet, runId);
  return persistedSet;
}

async function indexAppliedItems(
  deps: ConnectorPodIndexingDeps,
  metadata: ConnectorSourceMetadata,
  rootPath: string,
  items: readonly ConnectorSyncContentItem[],
  retainUndiscoveredDocuments: boolean,
): Promise<AppliedRunArtifacts> {
  if (items.length === 0) return { indexing: undefined, failedRelativePaths: new Set() };
  const scope = htmlManualReachableFilesScope(
    rootPath,
    items.map((item) => item.relativePath),
  );
  if (scope === null) {
    throw new KnowledgeStoreError("connector sync produced an unsafe indexing scope");
  }
  ensureConnectorSourceAttached(deps, connectorSourceDisplayName(metadata), scope);
  const drained = await runConnectorIndexing(deps, rootPath, items, retainUndiscoveredDocuments);
  applyDocumentTitles(deps, items);
  return { indexing: drained.result, failedRelativePaths: drained.failedRelativePaths };
}

function connectorSourceDisplayName(metadata: ConnectorSourceMetadata): string {
  return `${metadata.provider}:${metadata.connectorId}`;
}

// Apply one applicable sync run to the pod: index fetched items incrementally (unchanged
// documents skip re-embedding via the orchestrator's fast path), prune enumeration-confirmed
// removals, advance the fingerprint baseline on a clean index, and persist the redacted change
// summary. Returns the terminal change summary plus the refreshed pod summary.
// Carried entries join the run's fingerprint view (diffing as unchanged and surviving into the
// replaced set), and carried keys are enumeration-confirmed for removal detection.
function buildAppliedChanges(
  prior: ReadonlyMap<string, ConnectorItemFingerprint>,
  input: ConnectorSyncRunInput,
  indexing: IndexingResult | undefined,
): AppliedChangeInputs {
  const carriedItemKeys = input.carriedItemKeys ?? [];
  return {
    prior,
    fingerprints: [
      ...itemFingerprints(input.items),
      ...carriedFingerprintsFrom(prior, carriedItemKeys),
    ],
    removedItemKeys: removedKeysWithinScope(prior, [
      ...input.enumeratedItemKeys,
      ...carriedItemKeys,
    ]),
    input,
    indexing,
  };
}

export async function applyConnectorSyncRun(
  deps: ConnectorPodIndexingDeps,
  input: ConnectorSyncRunInput,
): Promise<ConnectorSyncApplyResult> {
  const metadata = requireConnectorSourceMetadata(deps.store, deps.capsuleId, deps.sourceId);
  const rootPath = `${CONNECTOR_VIRTUAL_ROOT_PREFIX}/${deps.capsuleId}`;
  const prior = readConnectorItemFingerprints(deps.store, deps.capsuleId, deps.sourceId);
  const runId = input.runId ?? deps.idSource?.() ?? randomUUID();
  const carriedMode = (input.carriedItemKeys ?? []).length > 0;
  const artifacts = await indexAppliedItems(deps, metadata, rootPath, input.items, carriedMode);
  const changes = buildAppliedChanges(prior, input, artifacts.indexing);
  const outcome = appliedOutcome(changes);
  const applied = outcome === "succeeded" || outcome === "partial";
  const persistedSet: readonly ConnectorItemFingerprint[] = applied
    ? persistAppliedBaseline(deps, changes, artifacts, runId, carriedMode)
    : [...prior.values()];
  const summary = changeSummaryFor(
    outcome,
    appliedCounts(changes),
    persistedSet,
    (deps.now ?? deps.store._internal.now)(),
  );
  persistTerminalSyncState(
    deps,
    runId,
    summary,
    appliedFailureReason(changes),
    applied ? input.providerWatermark : undefined,
  );
  finalizeAppliedLifecycle(deps, outcome, input.items.length);
  return {
    changeSummary: summary,
    ...(artifacts.indexing === undefined ? {} : { indexing: artifacts.indexing }),
    summary: buildConnectorPodSummary(deps.store, deps.capsuleId),
  };
}

// An applied run with zero fetched items never ran the indexing job (which is what normally
// advances the capsule out of draft), so lifecycle is finalized explicitly; an indexing run
// already set ready/error itself (orchestrator terminal transition).
function finalizeAppliedLifecycle(
  deps: ConnectorPodDeps,
  outcome: AtlassianSyncTerminalStatus,
  itemCount: number,
): void {
  if (itemCount > 0) return;
  if (outcome === "succeeded" || outcome === "partial") {
    updateCapsuleState(deps.store, deps.capsuleId, "ready");
  }
}

// ─── Unapplied run bookkeeping ─────────────────────────────────────────────────
export interface UnappliedConnectorSyncRunInput {
  readonly runId?: string | undefined;
  readonly outcome: Extract<AtlassianSyncTerminalStatus, "partial" | "failed" | "cancelled">;
  readonly failureReason?: AtlassianSyncFailureReason | undefined;
}

// Record a run that did NOT apply (cancelled, truncated by a run budget, or failed): no content
// commit, zero added/changed/removed, prior pod state fully intact. A failed run marks the
// capsule `error` (ADR-0128 D5 readiness mapping — auth-failed additionally projects as
// `unavailable` in the pod summary); a cancelled or truncated run leaves the lifecycle unchanged.
export function recordUnappliedConnectorSyncRun(
  deps: ConnectorPodDeps,
  input: UnappliedConnectorSyncRunInput,
): ConnectorSyncApplyResult {
  requireConnectorSourceMetadata(deps.store, deps.capsuleId, deps.sourceId);
  const prior = readConnectorItemFingerprints(deps.store, deps.capsuleId, deps.sourceId);
  const runId = input.runId ?? deps.idSource?.() ?? randomUUID();
  const counts: AtlassianSyncChangeCounts = {
    addedItems: 0,
    changedItems: 0,
    removedItems: 0,
    unchangedItems: 0,
    failedItems: 0,
    deniedItems: 0,
  };
  const summary = changeSummaryFor(
    input.outcome,
    counts,
    [...prior.values()],
    (deps.now ?? deps.store._internal.now)(),
  );
  persistTerminalSyncState(deps, runId, summary, input.failureReason);
  if (input.outcome === "failed") {
    updateCapsuleState(deps.store, deps.capsuleId, "error");
  }
  return { changeSummary: summary, summary: buildConnectorPodSummary(deps.store, deps.capsuleId) };
}
