// Approved connector sync scope persistence for connector-backed Knowledge Pods (Epic #2238,
// Issue #2242, ADR-0128 D5).
//
// Mirrors `manual-source-metadata.ts` for the connector lane: the approved scope (provider,
// connector id, base URL, scope keys, run bounds) is persisted at pod-create time and is the ONLY
// place a re-sync reconstructs its scope from — the caller can never supply or widen the scope
// (scope preservation; new spaces are never added implicitly). Additive sync bookkeeping (last
// run id/time, terminal status, closed failure reason, redacted change-summary JSON) never
// mutates the approved scope columns.
//
// Citation click-through targets resolve here as well (`resolveConnectorCitationTarget`): the
// stored per-item `webui_path` joined onto the connector's validated https base URL — the same
// role `resolveHtmlManualCitationTarget` plays for manual pods.

import {
  isJiraIssueCitationMetadata,
  isSafeAtlassianConnectorBaseUrl,
  validateAtlassianSyncBounds,
  type AtlassianConnectorProvider,
  type AtlassianSyncBounds,
  type AtlassianSyncFailureReason,
  type AtlassianSyncTerminalStatus,
  type DocumentId,
  type JiraIssueCitationMetadata,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "./errors.js";
import type { KnowledgeStore } from "./store.js";

export interface ConnectorSourceDefinition {
  readonly provider: AtlassianConnectorProvider;
  readonly connectorId: string;
  readonly baseUrl: string;
  readonly scopeKeys: readonly string[];
  // Approved opaque JQL narrowing (#2243, Jira only). Persisted beside the project keys so a
  // re-sync reconstructs the EXACT approved scope — a request can never widen or swap it. Never
  // projected into pod summaries, activity, or evidence (ADR-0128 D6 hashes or omits JQL).
  readonly jql?: string | undefined;
  readonly bounds: AtlassianSyncBounds;
}

export interface ConnectorSourceMetadata extends ConnectorSourceDefinition {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly lastSyncAt?: number | undefined;
  readonly lastSyncRunId?: string | undefined;
  readonly lastSyncStatus?: AtlassianSyncTerminalStatus | undefined;
  readonly lastFailureReason?: AtlassianSyncFailureReason | undefined;
  readonly lastChangeSummaryJson?: string | undefined;
  // Verbatim provider `updated` watermark of the last APPLIED run (#2243 incremental narrowing).
  // Provider clock, compared in UTC downstream — never the local wall clock.
  readonly providerWatermark?: string | undefined;
}

interface ConnectorSourceRow {
  readonly capsule_id: string;
  readonly source_id: string;
  readonly provider: AtlassianConnectorProvider;
  readonly connector_id: string;
  readonly base_url: string;
  readonly scope_keys_json: string;
  readonly scope_jql: string | null;
  readonly max_items: number;
  readonly max_bytes: number;
  readonly max_duration_ms: number;
  readonly max_concurrency: number;
  readonly last_sync_at: number | null;
  readonly last_sync_run_id: string | null;
  readonly last_sync_status: string | null;
  readonly last_failure_reason: string | null;
  readonly last_change_summary_json: string | null;
  readonly provider_watermark: string | null;
}

// Persist the approved connector scope at pod-create time. `INSERT OR REPLACE` resets the row to
// its create-time shape; sync bookkeeping is written separately via `updateConnectorSyncState`.
export function persistConnectorSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  definition: ConnectorSourceDefinition,
): void {
  store._internal.db
    .prepare(
      [
        "INSERT OR REPLACE INTO connector_sources (",
        "  capsule_id, source_id, provider, connector_id, base_url, scope_keys_json, scope_jql,",
        "  max_items, max_bytes, max_duration_ms, max_concurrency, created_at",
        ") VALUES (:capsule_id, :source_id, :provider, :connector_id, :base_url,",
        "  :scope_keys_json, :scope_jql, :max_items, :max_bytes, :max_duration_ms,",
        "  :max_concurrency, :created_at)",
      ].join(" "),
    )
    .run({
      capsule_id: capsuleId,
      source_id: sourceId,
      provider: definition.provider,
      connector_id: definition.connectorId,
      base_url: definition.baseUrl,
      scope_keys_json: JSON.stringify(definition.scopeKeys),
      scope_jql: definition.jql ?? null,
      max_items: definition.bounds.maxItems,
      max_bytes: definition.bounds.maxBytes,
      max_duration_ms: definition.bounds.maxDurationMs,
      max_concurrency: definition.bounds.maxConcurrency,
      created_at: store._internal.now(),
    });
}

// Record the outcome of one terminal sync run. Only the additive bookkeeping columns are touched;
// the approved provider/connector/base-URL/scope/bounds columns are never mutated by a sync run.
export interface ConnectorSyncState {
  readonly lastSyncAt: number;
  readonly lastSyncRunId: string;
  readonly lastSyncStatus: AtlassianSyncTerminalStatus;
  readonly lastFailureReason?: AtlassianSyncFailureReason | undefined;
  readonly changeSummaryJson: string;
  // Advances only on APPLIED runs (#2243): absent keeps the previously persisted watermark, so an
  // unapplied (failed/cancelled/truncated) run can never move the incremental cutoff forward.
  readonly providerWatermark?: string | undefined;
}

export function updateConnectorSyncState(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  state: ConnectorSyncState,
): void {
  store._internal.db
    .prepare(
      [
        "UPDATE connector_sources SET",
        "  last_sync_at = :last_sync_at,",
        "  last_sync_run_id = :last_sync_run_id,",
        "  last_sync_status = :last_sync_status,",
        "  last_failure_reason = :last_failure_reason,",
        "  last_change_summary_json = :last_change_summary_json,",
        "  provider_watermark = COALESCE(:provider_watermark, provider_watermark)",
        "WHERE capsule_id = :capsule_id AND source_id = :source_id",
      ].join(" "),
    )
    .run({
      capsule_id: capsuleId,
      source_id: sourceId,
      last_sync_at: state.lastSyncAt,
      last_sync_run_id: state.lastSyncRunId,
      last_sync_status: state.lastSyncStatus,
      last_failure_reason: state.lastFailureReason ?? null,
      last_change_summary_json: state.changeSummaryJson,
      provider_watermark: state.providerWatermark ?? null,
    });
}

function scopeKeysFromJson(json: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KnowledgeStoreError("persisted connector scope keys are unreadable");
  }
  if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === "string")) {
    throw new KnowledgeStoreError("persisted connector scope keys are unreadable");
  }
  return parsed;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "partial",
  "succeeded",
  "failed",
  "cancelled",
]);

function optionalTerminalStatus(value: string | null): AtlassianSyncTerminalStatus | undefined {
  return value !== null && TERMINAL_STATUSES.has(value)
    ? (value as AtlassianSyncTerminalStatus)
    : undefined;
}

function rowToMetadata(row: ConnectorSourceRow): ConnectorSourceMetadata {
  const bounds = validateAtlassianSyncBounds({
    maxItems: row.max_items,
    maxBytes: row.max_bytes,
    maxDurationMs: row.max_duration_ms,
    maxConcurrency: row.max_concurrency,
  });
  if (!bounds.ok) {
    throw new KnowledgeStoreError("persisted connector sync bounds are invalid; cannot sync");
  }
  const status = optionalTerminalStatus(row.last_sync_status);
  return {
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    provider: row.provider,
    connectorId: row.connector_id,
    baseUrl: row.base_url,
    scopeKeys: scopeKeysFromJson(row.scope_keys_json),
    ...(row.scope_jql !== null ? { jql: row.scope_jql } : {}),
    bounds: bounds.value,
    ...(row.last_sync_at !== null ? { lastSyncAt: row.last_sync_at } : {}),
    ...(row.last_sync_run_id !== null ? { lastSyncRunId: row.last_sync_run_id } : {}),
    ...(status !== undefined ? { lastSyncStatus: status } : {}),
    ...(row.last_failure_reason !== null
      ? { lastFailureReason: row.last_failure_reason as AtlassianSyncFailureReason }
      : {}),
    ...(row.last_change_summary_json !== null
      ? { lastChangeSummaryJson: row.last_change_summary_json }
      : {}),
    ...(row.provider_watermark !== null ? { providerWatermark: row.provider_watermark } : {}),
  };
}

export function readConnectorSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): ConnectorSourceMetadata | undefined {
  const row = store._internal.db
    .prepare(
      "SELECT * FROM connector_sources WHERE capsule_id = :capsuleId AND source_id = :sourceId",
    )
    .get({ capsuleId, sourceId }) as ConnectorSourceRow | undefined;
  return row === undefined ? undefined : rowToMetadata(row);
}

// List every connector source attached to a capsule (a connector pod carries exactly one today;
// the projection stays total anyway).
export function listConnectorSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly ConnectorSourceMetadata[] {
  const rows = store._internal.db
    .prepare("SELECT * FROM connector_sources WHERE capsule_id = :capsuleId ORDER BY source_id")
    .all({ capsuleId }) as unknown as ConnectorSourceRow[];
  return rows.map(rowToMetadata);
}

// ─── Citation click-through resolution ─────────────────────────────────────────
export type ConnectorCitationTargetResolution =
  | {
      readonly ok: true;
      readonly target: string;
      readonly pageTitle: string;
      readonly itemKey: string;
      // Provider-structured citation metadata (#2243, Jira): present only when the persisted
      // projection re-validates against the contract guard — a tampered or drifted row degrades
      // to a link-only citation rather than surfacing unvalidated fields.
      readonly citationMetadata?: JiraIssueCitationMetadata | undefined;
    }
  | {
      readonly ok: false;
      readonly reason:
        "source-metadata-unavailable" | "citation-lineage-mismatch" | "target-unsupported";
    };

interface CitationDocumentRow {
  readonly document_path: string;
  readonly safe_display_name: string;
}

interface CitationItemRow {
  readonly item_key: string;
  readonly webui_path: string | null;
  readonly citation_metadata_json: string | null;
}

// Fail-closed re-validation of the persisted metadata projection: parse, then require the shared
// contract guard. Anything else (unparseable, non-record, unvalidated shape) resolves to absent.
function validatedCitationMetadata(json: string | null): JiraIssueCitationMetadata | undefined {
  if (json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isJiraIssueCitationMetadata(parsed) ? parsed : undefined;
}

function readCitationDocument(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
): CitationDocumentRow | undefined {
  return store._internal.db
    .prepare(
      [
        "SELECT document_path, safe_display_name FROM documents",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId AND id = :documentId",
      ].join(" "),
    )
    .get({ capsuleId, sourceId, documentId }) as CitationDocumentRow | undefined;
}

function readItemByRelativePath(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  relativePath: string,
): CitationItemRow | undefined {
  return store._internal.db
    .prepare(
      [
        "SELECT item_key, webui_path, citation_metadata_json FROM connector_item_fingerprints",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId",
        "AND relative_path = :relativePath",
      ].join(" "),
    )
    .get({ capsuleId, sourceId, relativePath }) as CitationItemRow | undefined;
}

// Document rows may store either the absolute mount path (`<virtual root>/pages/<id>.html`) or
// the scope-relative path (`pages/<id>.html`) depending on the discovery writer; the fingerprint
// rows always store the id-derived relative form. Normalize to the relative form for the join.
// Two mount roots exist: `pages/` (Confluence, #2242) and `issues/` (Jira, #2243).
const CONNECTOR_MOUNT_ROOTS = ["pages/", "issues/"] as const;

function relativePathOfDocumentPath(documentPath: string): string | undefined {
  for (const root of CONNECTOR_MOUNT_ROOTS) {
    if (documentPath.startsWith(root)) return documentPath;
    const index = documentPath.lastIndexOf(`/${root}`);
    if (index !== -1) return documentPath.slice(index + 1);
  }
  return undefined;
}

// Resolve a retrieval citation on a connector pod to its provider webui link + page title. Fails
// closed: a document outside the connector source, a missing fingerprint row, an absent webui
// path, or an off-base target all refuse rather than fabricate a link.
export function resolveConnectorCitationTarget(
  store: KnowledgeStore,
  input: {
    readonly capsuleId: KnowledgeCapsuleId;
    readonly sourceId: KnowledgeSourceId;
    readonly documentId: DocumentId;
  },
): ConnectorCitationTargetResolution {
  const metadata = readConnectorSourceMetadata(store, input.capsuleId, input.sourceId);
  if (metadata === undefined) return { ok: false, reason: "source-metadata-unavailable" };
  const document = readCitationDocument(store, input.capsuleId, input.sourceId, input.documentId);
  if (document === undefined) return { ok: false, reason: "citation-lineage-mismatch" };
  const relativePath = relativePathOfDocumentPath(document.document_path);
  const item =
    relativePath === undefined
      ? undefined
      : readItemByRelativePath(store, input.capsuleId, input.sourceId, relativePath);
  if (item === undefined) return { ok: false, reason: "citation-lineage-mismatch" };
  if (item.webui_path === null || !isSafeAtlassianConnectorBaseUrl(metadata.baseUrl)) {
    return { ok: false, reason: "target-unsupported" };
  }
  const base = new URL(metadata.baseUrl);
  const target = new URL(`${base.origin}${item.webui_path}`);
  if (target.host !== base.host || target.protocol !== "https:") {
    return { ok: false, reason: "target-unsupported" };
  }
  const citationMetadata = validatedCitationMetadata(item.citation_metadata_json);
  return {
    ok: true,
    target: target.toString(),
    pageTitle: document.safe_display_name,
    itemKey: item.item_key,
    ...(citationMetadata === undefined ? {} : { citationMetadata }),
  };
}
