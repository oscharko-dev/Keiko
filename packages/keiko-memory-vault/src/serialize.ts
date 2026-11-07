// Pure row↔record translation. The row shape mirrors the schema.ts column layout 1:1; the record
// shape is the contract's MemoryRecord. We keep both layers in this single module so a schema
// column rename has exactly one place to update.
//
// Encoding choices:
//   - tags          → JSON array string
//   - payload       → JSON-stringified discriminated union (NULL when absent)
//   - validUntil    → NULL when absent (NOT undefined-as-string)
//   - staleReason   → NULL when absent
//   - retentionHint → flattened across three columns; NULL all when absent
//   - sensitivity   → flat column (validator treats it as a provenance attribute but storing it
//                     flat keeps the scoped-list query free of payload parsing for the common case)

import type {
  MemoryId,
  MemoryProvenance,
  MemoryRecord,
  MemoryRetentionHint,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryStructuredPayload,
  MemoryType,
  MemoryValidityInterval,
  ConversationId,
  EvidenceManifestId,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import { MemoryStorageError } from "./errors.js";
import type { MemoryContentCipher } from "./cipher.js";

// Content-vs-metadata split (ADR-0035): only the columns that carry remembered TEXT are sealed —
// body, payload_json, tags_json, capture_rationale, stale_reason, evidence_span. Every other column (ids, scope,
// status, sensitivity, pinned, confidence, all timestamps, source_*, model_*, retention_*) stays
// cleartext so SQL indexes and the UI scope display keep working without a key. Crypto is confined
// to the two wrapper functions below; the pure row↔record builders never see a key.

type ContentColumns = Pick<
  MemoryRow,
  "body" | "payload_json" | "tags_json" | "capture_rationale" | "stale_reason" | "evidence_span"
>;

// One mapping for both directions, so a newly sealed column cannot be sealed but never opened.
function mapContentColumns<T extends ContentColumns>(row: T, map: (value: string) => string): T {
  const nullable = (value: string | null): string | null => (value === null ? null : map(value));
  return {
    ...row,
    body: map(row.body),
    payload_json: nullable(row.payload_json),
    tags_json: map(row.tags_json),
    capture_rationale: nullable(row.capture_rationale),
    stale_reason: nullable(row.stale_reason),
    evidence_span: nullable(row.evidence_span),
  };
}

// Returns a row whose sealed content columns are decrypted in place, so the pure builders below run
// on plaintext exactly as they did before encryption landed.
function decryptContentColumns(row: MemoryRow, cipher: MemoryContentCipher): MemoryRow {
  return mapContentColumns(row, (value) => cipher.openString(value));
}

// Returns a write-row whose content columns are sealed, leaving every metadata column untouched.
function encryptContentColumns(row: MemoryRowWrite, cipher: MemoryContentCipher): MemoryRowWrite {
  return mapContentColumns(row, (value) => cipher.sealString(value));
}

export interface MemoryRow {
  readonly id: string;
  readonly schema_version: string;
  readonly type: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly body: string;
  readonly payload_json: string | null;
  readonly status: string;
  readonly sensitivity: string;
  readonly pinned: number;
  readonly confidence: number;
  readonly valid_from: number;
  readonly valid_until: number | null;
  readonly stale_reason: string | null;
  readonly tags_json: string;
  readonly source_kind: string;
  readonly source_conversation_id: string | null;
  readonly source_workflow_run_id: string | null;
  readonly source_evidence_manifest_id: string | null;
  readonly captured_at: number;
  readonly capture_rationale: string | null;
  readonly model_provider: string | null;
  readonly model_id: string | null;
  readonly model_revision: string | null;
  readonly retention_policy_key: string | null;
  readonly retention_retain_until: number | null;
  readonly retention_notes: string | null;
  readonly evidence_span: string | null;
  readonly source_message_ids_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function buildScopeFromRow(kind: string, coord: string): MemoryScope {
  switch (kind as MemoryScopeKind) {
    case "user":
      return { kind: "user", userId: coord as UserId };
    case "workspace":
      return { kind: "workspace", workspaceId: coord as WorkspaceId };
    case "project":
      return { kind: "project", projectId: coord as ProjectId };
    case "workflow":
      return { kind: "workflow", workflowDefinitionId: coord as WorkflowDefinitionId };
    case "global":
      return { kind: "global" };
    default:
      throw new MemoryStorageError(
        "schema-mismatch",
        "Stored memory scope kind is not recognized.",
      );
  }
}

// Like the tags and payload columns, a damaged list is a storage error, never a silent guess.
function parsedSourceMessageIds(json: string | null): readonly string[] | undefined {
  if (json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MemoryStorageError("schema-mismatch", "Stored source message ids JSON is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored source message ids JSON must be an array of strings.",
    );
  }
  return parsed as string[];
}

function buildProvenanceFromRow(row: MemoryRow): MemoryProvenance {
  const base: {
    sourceKind: MemorySourceKind;
    capturedAt: number;
    confidence: number;
    sensitivity: MemorySensitivity;
    sourceConversationId?: ConversationId;
    sourceWorkflowRunId?: WorkflowRunId;
    sourceEvidenceManifestId?: EvidenceManifestId;
    modelIdentity?: { provider: string; modelId: string; modelRevision?: string };
    captureRationale?: string;
    evidenceSpan?: string;
    sourceMessageIds?: readonly string[];
  } = {
    sourceKind: row.source_kind as MemorySourceKind,
    capturedAt: row.captured_at,
    confidence: row.confidence,
    sensitivity: row.sensitivity as MemorySensitivity,
  };
  if (row.source_conversation_id !== null) {
    base.sourceConversationId = row.source_conversation_id as ConversationId;
  }
  if (row.source_workflow_run_id !== null) {
    base.sourceWorkflowRunId = row.source_workflow_run_id as WorkflowRunId;
  }
  if (row.source_evidence_manifest_id !== null) {
    base.sourceEvidenceManifestId = row.source_evidence_manifest_id as EvidenceManifestId;
  }
  if (row.capture_rationale !== null) {
    base.captureRationale = row.capture_rationale;
  }
  if (row.evidence_span !== null) base.evidenceSpan = row.evidence_span;
  const sourceMessageIds = parsedSourceMessageIds(row.source_message_ids_json);
  if (sourceMessageIds !== undefined) base.sourceMessageIds = sourceMessageIds;
  if (row.model_provider !== null && row.model_id !== null) {
    const identity: { provider: string; modelId: string; modelRevision?: string } = {
      provider: row.model_provider,
      modelId: row.model_id,
    };
    if (row.model_revision !== null) identity.modelRevision = row.model_revision;
    base.modelIdentity = identity;
  }
  return base;
}

function buildValidityFromRow(row: MemoryRow): MemoryValidityInterval {
  return row.valid_until === null
    ? { validFrom: row.valid_from }
    : { validFrom: row.valid_from, validUntil: row.valid_until };
}

function buildRetentionHintFromRow(row: MemoryRow): MemoryRetentionHint | undefined {
  if (row.retention_policy_key === null) return undefined;
  const hint: { policyKey: string; retainUntil?: number; notes?: string } = {
    policyKey: row.retention_policy_key,
  };
  if (row.retention_retain_until !== null) hint.retainUntil = row.retention_retain_until;
  if (row.retention_notes !== null) hint.notes = row.retention_notes;
  return hint;
}

function parseTagsJson(raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryStorageError("schema-mismatch", "Stored memory tags JSON is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored memory tags JSON must be an array of strings.",
    );
  }
  return parsed as string[];
}

function parsePayloadJson(raw: string | null): MemoryStructuredPayload | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryStorageError("schema-mismatch", "Stored memory payload JSON is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored memory payload JSON must be an object payload.",
    );
  }
  return parsed as MemoryStructuredPayload;
}

export function rowToMemoryRecord(row: MemoryRow, cipher: MemoryContentCipher): MemoryRecord {
  const decrypted = decryptContentColumns(row, cipher);
  return decryptedRowToMemoryRecord(decrypted);
}

function decryptedRowToMemoryRecord(row: MemoryRow): MemoryRecord {
  const payload = parsePayloadJson(row.payload_json);
  const retentionHint = buildRetentionHintFromRow(row);
  const base = {
    id: row.id as MemoryId,
    schemaVersion: "1" as const,
    scope: buildScopeFromRow(row.scope_kind, row.scope_coordinate),
    type: row.type as MemoryType,
    body: row.body,
    provenance: buildProvenanceFromRow(row),
    validity: buildValidityFromRow(row),
    status: row.status as MemoryStatus,
    pinned: row.pinned === 1,
    tags: parseTagsJson(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies Omit<MemoryRecord, "staleReason" | "retentionHint" | "payload">;
  const out: MemoryRecord = {
    ...base,
    ...(payload !== undefined ? { payload } : {}),
    ...(row.stale_reason !== null ? { staleReason: row.stale_reason } : {}),
    ...(retentionHint !== undefined ? { retentionHint } : {}),
  };
  return out;
}

// A written row has exactly the columns a read row has.
export type MemoryRowWrite = MemoryRow;

type ProvenanceRowFields = Pick<
  MemoryRowWrite,
  | "sensitivity"
  | "confidence"
  | "source_kind"
  | "source_conversation_id"
  | "source_workflow_run_id"
  | "source_evidence_manifest_id"
  | "captured_at"
  | "capture_rationale"
  | "evidence_span"
  | "source_message_ids_json"
  | "model_provider"
  | "model_id"
  | "model_revision"
>;

type ModelIdentityRowFields = Pick<
  MemoryRowWrite,
  "model_provider" | "model_id" | "model_revision"
>;

function modelIdentityFieldsToRow(
  identity: MemoryRecord["provenance"]["modelIdentity"],
): ModelIdentityRowFields {
  return {
    model_provider: identity?.provider ?? null,
    model_id: identity?.modelId ?? null,
    model_revision: identity?.modelRevision ?? null,
  };
}

function provenanceFieldsToRow(prov: MemoryRecord["provenance"]): ProvenanceRowFields {
  return {
    sensitivity: prov.sensitivity,
    confidence: prov.confidence,
    source_kind: prov.sourceKind,
    source_conversation_id: prov.sourceConversationId ?? null,
    source_workflow_run_id: prov.sourceWorkflowRunId ?? null,
    source_evidence_manifest_id: prov.sourceEvidenceManifestId ?? null,
    captured_at: prov.capturedAt,
    capture_rationale: prov.captureRationale ?? null,
    evidence_span: prov.evidenceSpan ?? null,
    source_message_ids_json:
      prov.sourceMessageIds === undefined ? null : JSON.stringify(prov.sourceMessageIds),
    ...modelIdentityFieldsToRow(prov.modelIdentity),
  };
}

type RetentionRowFields = Pick<
  MemoryRowWrite,
  "retention_policy_key" | "retention_retain_until" | "retention_notes"
>;

function retentionFieldsToRow(hint: MemoryRecord["retentionHint"]): RetentionRowFields {
  return {
    retention_policy_key: hint?.policyKey ?? null,
    retention_retain_until: hint?.retainUntil ?? null,
    retention_notes: hint?.notes ?? null,
  };
}

export function memoryRecordToRow(
  record: MemoryRecord,
  cipher: MemoryContentCipher,
): MemoryRowWrite {
  return encryptContentColumns(plainRecordToRow(record), cipher);
}

function plainRecordToRow(record: MemoryRecord): MemoryRowWrite {
  return {
    id: record.id,
    schema_version: record.schemaVersion,
    type: record.type,
    scope_kind: scopeKindOf(record.scope),
    scope_coordinate: scopeCoordinateOf(record.scope),
    body: record.body,
    payload_json: record.payload === undefined ? null : JSON.stringify(record.payload),
    status: record.status,
    pinned: record.pinned ? 1 : 0,
    valid_from: record.validity.validFrom,
    valid_until: record.validity.validUntil ?? null,
    stale_reason: record.staleReason ?? null,
    tags_json: JSON.stringify(record.tags),
    ...provenanceFieldsToRow(record.provenance),
    ...retentionFieldsToRow(record.retentionHint),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}
