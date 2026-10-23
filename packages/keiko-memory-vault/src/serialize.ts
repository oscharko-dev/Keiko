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
  MemoryRecord,
  MemoryRetentionHint,
  MemoryScope,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  validateMemoryRecord,
  validateMemoryScope,
  validateMemoryStructuredPayload,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import { MemoryStorageError } from "./errors.js";
import type { MemoryContentCipher } from "./cipher.js";

// Content-vs-metadata split (ADR-0035): only the columns that carry remembered TEXT are sealed —
// body, payload_json, tags_json, capture_rationale, stale_reason. Every other column (ids, scope,
// status, sensitivity, pinned, confidence, all timestamps, source_*, model_*, retention_*) stays
// cleartext so SQL indexes and the UI scope display keep working without a key. Crypto is confined
// to the two wrapper functions below; the pure row↔record builders never see a key.

function openNullable(cipher: MemoryContentCipher, value: string | null): string | null {
  return value === null ? null : cipher.openString(value);
}

// Returns a row whose sealed content columns are decrypted in place, so the pure builders below run
// on plaintext exactly as they did before encryption landed.
function decryptContentColumns(row: MemoryRow, cipher: MemoryContentCipher): MemoryRow {
  return {
    ...row,
    body: cipher.openString(row.body),
    payload_json: openNullable(cipher, row.payload_json),
    tags_json: cipher.openString(row.tags_json),
    capture_rationale: openNullable(cipher, row.capture_rationale),
    stale_reason: openNullable(cipher, row.stale_reason),
  };
}

function sealNullable(cipher: MemoryContentCipher, value: string | null): string | null {
  return value === null ? null : cipher.sealString(value);
}

// Returns a write-row whose content columns are sealed, leaving every metadata column untouched.
function encryptContentColumns(row: MemoryRowWrite, cipher: MemoryContentCipher): MemoryRowWrite {
  return {
    ...row,
    body: cipher.sealString(row.body),
    payload_json: sealNullable(cipher, row.payload_json),
    tags_json: cipher.sealString(row.tags_json),
    capture_rationale: sealNullable(cipher, row.capture_rationale),
    stale_reason: sealNullable(cipher, row.stale_reason),
  };
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
  readonly created_at: number;
  readonly updated_at: number;
}

function scopeCandidateFromRow(kind: string, coord: string): Readonly<Record<string, string>> {
  switch (kind) {
    case "user":
      return { kind, userId: coord };
    case "workspace":
      return { kind, workspaceId: coord };
    case "project":
      return { kind, projectId: coord };
    case "workflow":
      return { kind, workflowDefinitionId: coord };
    case "global":
      return { kind };
    default:
      throw new MemoryStorageError(
        "schema-mismatch",
        "Stored memory scope kind is not recognized.",
      );
  }
}

function buildScopeFromRow(kind: string, coord: string): MemoryScope {
  const result = validateMemoryScope(scopeCandidateFromRow(kind, coord));
  if (!result.ok) {
    throw new MemoryStorageError("schema-mismatch", "Stored memory scope coordinate is invalid.");
  }
  return result.value;
}

function buildProvenanceFromRow(row: MemoryRow): object {
  return {
    sourceKind: row.source_kind,
    capturedAt: row.captured_at,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    ...(row.source_conversation_id !== null
      ? { sourceConversationId: row.source_conversation_id }
      : {}),
    ...(row.source_workflow_run_id !== null
      ? { sourceWorkflowRunId: row.source_workflow_run_id }
      : {}),
    ...(row.source_evidence_manifest_id !== null
      ? { sourceEvidenceManifestId: row.source_evidence_manifest_id }
      : {}),
    ...(row.capture_rationale !== null ? { captureRationale: row.capture_rationale } : {}),
    ...(row.model_provider !== null && row.model_id !== null
      ? {
          modelIdentity: {
            provider: row.model_provider,
            modelId: row.model_id,
            ...(row.model_revision !== null ? { modelRevision: row.model_revision } : {}),
          },
        }
      : {}),
  };
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
  if (!Array.isArray(parsed) || !parsed.every((value: unknown) => typeof value === "string")) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored memory tags JSON must be an array of strings.",
    );
  }
  return parsed;
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
  const result = validateMemoryStructuredPayload(parsed);
  if (!result.ok) {
    throw new MemoryStorageError("schema-mismatch", "Stored memory structured payload is invalid.");
  }
  return result.value;
}

export function rowToMemoryRecord(row: MemoryRow, cipher: MemoryContentCipher): MemoryRecord {
  const decrypted = decryptContentColumns(row, cipher);
  return decryptedRowToMemoryRecord(decrypted);
}

function decryptedRowToMemoryRecord(row: MemoryRow): MemoryRecord {
  const payload = parsePayloadJson(row.payload_json);
  const retentionHint = buildRetentionHintFromRow(row);
  const base = {
    id: row.id,
    schemaVersion: row.schema_version,
    scope: buildScopeFromRow(row.scope_kind, row.scope_coordinate),
    type: row.type,
    body: row.body,
    provenance: buildProvenanceFromRow(row),
    validity: buildValidityFromRow(row),
    status: row.status,
    pinned: row.pinned === 1,
    tags: parseTagsJson(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const candidate = {
    ...base,
    ...(payload !== undefined ? { payload } : {}),
    ...(row.stale_reason !== null ? { staleReason: row.stale_reason } : {}),
    ...(retentionHint !== undefined ? { retentionHint } : {}),
  };
  const result = validateMemoryRecord(candidate);
  if (!result.ok) {
    throw new MemoryStorageError("schema-mismatch", "Stored memory record is invalid.");
  }
  return result.value;
}

export interface MemoryRowWrite {
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
  readonly created_at: number;
  readonly updated_at: number;
}

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
