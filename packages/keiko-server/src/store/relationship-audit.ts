// Epic #532 / Issue #539 — relationship audit ledger sibling-table writer.
//
// Append-only writer for the `relationship_audit_entries` table (see audit-events.md §5.5).
// Persistence-placement rule (audit-events.md §5.3): in this PR both run-scoped and
// non-run-scoped mutations route to the sibling table. EvidenceManifest.relationships?
// embedding is the responsibility of issue #544 (the `// TODO(#544)` comment in
// `resolveAuditPlacement` is the single seam where future code branches).
//
// Redaction-on-write: every payload string passes through `deepRedactStrings` with the
// injected `redactString` BEFORE the SQL INSERT (audit-events.md §7). The forbidden-key
// gate from `RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS` rejects payload keys that
// would smuggle prompt / document / secret content (audit-events.md §8.3).
//
// The append-only invariant (audit-events.md §9) is structural: this module exposes only
// `insertRelationshipAuditEntry` and `listRelationshipAuditEntries`. There is no UPDATE /
// DELETE seam. Retention sweeps live in #543 and are out of scope here.

import type { DatabaseSync } from "node:sqlite";
import { deepRedactStrings } from "@oscharko-dev/keiko-security";
import { RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS } from "@oscharko-dev/keiko-contracts";
import { invalidRequest } from "./errors.js";

export const RELATIONSHIP_AUDIT_SCHEMA_VERSION = "1" as const;
export const RELATIONSHIP_AUDIT_SUMMARY_MAX_CHARS = 240;

export type RelationshipAuditKind =
  | "relationship.created"
  | "relationship.updated"
  | "relationship.deleted"
  | "relationship.reconnected"
  | "relationship.validation-denied"
  | "relationship.policy-denied"
  | "relationship.activity-transitioned"
  | "relationship.impact-analysis-bounded"
  | "relationship.health-finding";

export type RelationshipAuditActorSurface =
  | "chat"
  | "inspector"
  | "workflow"
  | "health-check"
  | "system";

export type RelationshipAuditPlacement = "sibling-table" | "evidence-manifest";

export interface RelationshipAuditEntryInput {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly occurredAt: number;
  readonly kind: RelationshipAuditKind;
  readonly relationshipId?: string | undefined;
  readonly actor: {
    readonly surface: RelationshipAuditActorSurface;
    readonly redactedActorId: string;
  };
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RelationshipAuditEntryRow {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly kind: RelationshipAuditKind;
  readonly relationshipId: string | undefined;
  readonly actorSurface: RelationshipAuditActorSurface;
  readonly redactedActorId: string;
  readonly redactionState: "redacted-on-write" | "redacted-on-write-and-persist";
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// Selects where the row lives. Audit-events.md §5.3: the source endpoint kind decides.
// For now both branches return "sibling-table"; the workflow-run branch is reserved for
// #544 wiring EvidenceManifest.relationships?.
export function resolveAuditPlacement(input: {
  readonly kind: RelationshipAuditKind;
  readonly sourceKind?: string | undefined;
}): RelationshipAuditPlacement {
  // TODO(#544): wire EvidenceManifest.relationships? when sourceKind === "workflow-run"
  // and the request handler holds an evidenceRunId. Until then every row lands in the
  // sibling table — this is the documented Issue #539 placement.
  void input;
  return "sibling-table";
}

// Sequence is allocated atomically inside the INSERT via a subquery — no separate
// SELECT MAX then JS-side increment. SQLite serialises writers so COALESCE(MAX(sequence),-1)+1
// is the next monotonic value with no TOCTOU gap. The WHERE clause keeps the subquery
// workspace-scoped (audit-events.md §10). When no prior rows exist COALESCE returns -1
// giving sequence 0 as the first value.
const SQL_INSERT_AUDIT = `
INSERT INTO relationship_audit_entries(
  event_id, relationship_audit_schema_ver, workspace_id, sequence, occurred_at,
  kind, relationship_id, actor_surface, redacted_actor_id, redaction_state, summary,
  payload_json
)
SELECT ?, ?, ?, COALESCE(MAX(sequence), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?
FROM relationship_audit_entries
WHERE workspace_id = ?
`;

const SQL_LIST_AUDIT = `
SELECT event_id, relationship_audit_schema_ver, workspace_id, sequence, occurred_at,
       kind, relationship_id, actor_surface, redacted_actor_id, redaction_state, summary,
       payload_json
FROM relationship_audit_entries
WHERE workspace_id = ?
ORDER BY occurred_at DESC, sequence DESC
LIMIT ?
`;

const SQL_LIST_AUDIT_FOR_RELATIONSHIP = `
SELECT event_id, relationship_audit_schema_ver, workspace_id, sequence, occurred_at,
       kind, relationship_id, actor_surface, redacted_actor_id, redaction_state, summary,
       payload_json
FROM relationship_audit_entries
WHERE workspace_id = ? AND relationship_id = ?
ORDER BY occurred_at DESC, sequence DESC
LIMIT ?
`;

export const MAX_AUDIT_LIST_LIMIT = 256;
export const DEFAULT_AUDIT_LIST_LIMIT = 64;

// Rejects any payload object whose key (or a nested key) contains a forbidden substring per
// audit-events.md §8.3. Same normalisation as the validator's forbidden-key gate in
// `@oscharko-dev/keiko-contracts/relationships-validation` so the API and audit edges agree.
function assertNoForbiddenKeys(payload: unknown, path = ""): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  for (const key of Object.keys(payload)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const banned of RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS) {
      if (normalized.includes(banned)) {
        throw invalidRequest(`Audit payload key "${path}${key}" is in the forbidden set.`);
      }
    }
    assertNoForbiddenKeys((payload as Record<string, unknown>)[key], `${path}${key}.`);
  }
}

function assertSummary(summary: string): void {
  if (summary.length > RELATIONSHIP_AUDIT_SUMMARY_MAX_CHARS) {
    throw invalidRequest("Audit summary exceeds the 240-char bound.");
  }
}

// Single redactor invocation site (audit-events.md §7). `redactString` is supplied by the
// API layer (typically `createAuditRedactor` + the configured secrets). The post-redaction
// shape is what hits the SQL INSERT — no second redaction inside this module.
export function insertRelationshipAuditEntry(
  db: DatabaseSync,
  entry: RelationshipAuditEntryInput,
  redactString: (value: string) => string,
): RelationshipAuditEntryRow {
  assertNoForbiddenKeys(entry.payload);
  assertSummary(entry.summary);
  const redactedSummary = redactString(entry.summary);
  assertSummary(redactedSummary);
  const redactedPayload = deepRedactStrings(entry.payload, redactString) as Readonly<
    Record<string, unknown>
  >;
  const payloadJson = JSON.stringify(redactedPayload);
  // The subquery's WHERE clause receives workspaceId as the last bind parameter so that
  // COALESCE(MAX(sequence),-1)+1 is scoped to the workspace. SQLite serialises writers so
  // this read-modify-write happens atomically with no TOCTOU gap.
  db.prepare(SQL_INSERT_AUDIT).run(
    entry.eventId,
    RELATIONSHIP_AUDIT_SCHEMA_VERSION,
    entry.workspaceId,
    entry.occurredAt,
    entry.kind,
    entry.relationshipId ?? null,
    entry.actor.surface,
    entry.actor.redactedActorId,
    "redacted-on-write",
    redactedSummary,
    payloadJson,
    entry.workspaceId,
  );
  const assigned = db
    .prepare("SELECT sequence FROM relationship_audit_entries WHERE event_id = ?")
    .get(entry.eventId) as { sequence: number } | undefined;
  if (assigned === undefined) throw new Error("Audit INSERT returned no row.");
  const row: RelationshipAuditEntryRow = {
    eventId: entry.eventId,
    workspaceId: entry.workspaceId,
    sequence: assigned.sequence,
    occurredAt: entry.occurredAt,
    kind: entry.kind,
    relationshipId: entry.relationshipId,
    actorSurface: entry.actor.surface,
    redactedActorId: entry.actor.redactedActorId,
    redactionState: "redacted-on-write",
    summary: redactedSummary,
    payload: redactedPayload,
  };
  return row;
}

interface AuditRowSqlite {
  readonly event_id: string;
  readonly workspace_id: string;
  readonly sequence: number;
  readonly occurred_at: number;
  readonly kind: string;
  readonly relationship_id: string | null;
  readonly actor_surface: string;
  readonly redacted_actor_id: string;
  readonly redaction_state: string;
  readonly summary: string;
  readonly payload_json: string;
}

function rowToEntry(row: AuditRowSqlite): RelationshipAuditEntryRow {
  const payload = JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>;
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    kind: row.kind as RelationshipAuditKind,
    relationshipId: row.relationship_id ?? undefined,
    actorSurface: row.actor_surface as RelationshipAuditActorSurface,
    redactedActorId: row.redacted_actor_id,
    redactionState:
      row.redaction_state === "redacted-on-write-and-persist"
        ? "redacted-on-write-and-persist"
        : "redacted-on-write",
    summary: row.summary,
    payload,
  };
}

export function listRelationshipAuditEntries(
  db: DatabaseSync,
  workspaceId: string,
  limit: number = DEFAULT_AUDIT_LIST_LIMIT,
): readonly RelationshipAuditEntryRow[] {
  if (limit <= 0 || limit > MAX_AUDIT_LIST_LIMIT) {
    throw invalidRequest("Audit limit out of bounds.");
  }
  const rows = db.prepare(SQL_LIST_AUDIT).all(workspaceId, limit) as unknown as AuditRowSqlite[];
  return rows.map(rowToEntry);
}

export function listRelationshipAuditEntriesForRelationship(
  db: DatabaseSync,
  workspaceId: string,
  relationshipId: string,
  limit: number = DEFAULT_AUDIT_LIST_LIMIT,
): readonly RelationshipAuditEntryRow[] {
  if (limit <= 0 || limit > MAX_AUDIT_LIST_LIMIT) {
    throw invalidRequest("Audit limit out of bounds.");
  }
  const rows = db
    .prepare(SQL_LIST_AUDIT_FOR_RELATIONSHIP)
    .all(workspaceId, relationshipId, limit) as unknown as AuditRowSqlite[];
  return rows.map(rowToEntry);
}
