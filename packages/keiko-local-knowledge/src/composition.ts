// composition.ts — Knowledge Capsule composition layer (Epic #189, Issue #263).
//
// Foundry-IQ "no global pool" rule lives in the type system (every record carries
// capsuleId/sourceId) and the SQL FKs. This module is the in-memory union and the
// audit-trail-emitting batch operations on top of that — pure functions over the store's
// existing capsule, source, and CapsuleSet primitives; no new vectors, no SQL joins
// across capsules.
//
// Exports:
//   * buildComposedRetrievalScope(store, setId)  → in-memory {capsuleIds, sourceIds, …}
//   * describeRetrievalScope(scope, store)        → UI-safe disclosure for the future #198
//   * addSourcesToCapsule(store, capsuleId, …)   → multi-source link + audit + updated_at
//   * composeCapsules(store, opts)                → createCapsuleSet + audit in one transaction
//   * listCapsuleMembershipChanges(store, id)     → audit reader for capsule history view
//   * CompositionError / CompositionErrorCode     → typed error surface
//   * ComposedRetrievalScope / RetrievalScopeDisclosure / CapsuleMembershipChange / …
//
// All multi-row writes wrap in BEGIN/COMMIT/ROLLBACK so a partial batch never lands.

import { randomUUID } from "node:crypto";

import {
  compareEmbeddingProfiles,
  embeddingProfileFromModelIdentity,
  validateKnowledgeSourceScope,
  type CapsuleSet,
  type CapsuleSetId,
  type KnowledgeCapsule,
  type KnowledgeCapsuleId,
  type KnowledgeSource,
  type KnowledgeSourceId,
  type KnowledgeSourceScopeKind,
} from "@oscharko-dev/keiko-contracts";

import { getCapsule } from "./capsule-lifecycle.js";
import { assertSafeDisplayField, assertSafeOptionalDisplayField } from "./display-validation.js";
import {
  getCapsuleSet,
  createCapsuleSet,
  createCapsuleSetWithinTxn,
} from "./capsule-set-lifecycle.js";
import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import {
  INSERT_KNOWLEDGE_SOURCE_SQL,
  INSERT_SQL,
  listCapsuleSources,
  scopeToJson,
  type AddCapsuleSourceInput,
} from "./source-lifecycle.js";
import { validateSourceRoutingForCapsule } from "./source-routing-validation.js";
import type { KnowledgeStore } from "./store.js";

// ─── Errors ────────────────────────────────────────────────────────────────────

export type CompositionErrorCode =
  | "empty-source-batch"
  | "duplicate-source-in-batch"
  | "source-already-linked"
  | "empty-capsule-list"
  | "duplicate-capsule-in-batch"
  | "incompatible-embedding-identity";

export class CompositionError extends Error {
  readonly code: CompositionErrorCode;
  constructor(code: CompositionErrorCode, message: string) {
    super(message);
    this.name = "CompositionError";
    this.code = code;
  }
}

// ─── Public surface ────────────────────────────────────────────────────────────

export interface ComposedRetrievalScope {
  readonly capsuleSetId: CapsuleSetId;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  // The member capsules composeScopeFromSet already loaded (existing members only,
  // in capsuleIds order). Threaded through to the retrieval pipeline so policy
  // resolution and the vector search never re-fetch the same capsule metadata —
  // previously ≈7 SQL round-trips per capsule per query (GEN-PERF-LK-001).
  readonly capsules: readonly KnowledgeCapsule[];
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly alwaysQueryCapsuleIds: readonly KnowledgeCapsuleId[];
  readonly sourceRoutingByCapsule: ReadonlyMap<KnowledgeCapsuleId, string>;
}

export interface RetrievalCapsuleSummary {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly sourceCount: number;
  readonly alwaysQuery: boolean;
}

export interface RetrievalSourceSummary {
  readonly id: KnowledgeSourceId;
  readonly displayName: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly scopeKind: KnowledgeSourceScopeKind;
}

export interface RetrievalScopeDisclosure {
  readonly capsuleSetId: CapsuleSetId;
  readonly capsuleSummaries: readonly RetrievalCapsuleSummary[];
  readonly sourceSummaries: readonly RetrievalSourceSummary[];
}

export type CapsuleMembershipChangeKind = "add-source" | "remove-source" | "compose-set";

export interface CapsuleMembershipChange {
  readonly id: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly changeKind: CapsuleMembershipChangeKind;
  readonly sourceId: KnowledgeSourceId | undefined;
  readonly detailsJson: string | undefined;
  readonly occurredAt: number;
}

export interface AddSourcesToCapsuleResult {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly addedSourceIds: readonly KnowledgeSourceId[];
}

export interface ComposeCapsulesOptions {
  readonly displayName: string;
  readonly description?: string;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly tags?: readonly string[];
}

// ─── buildComposedRetrievalScope ────────────────────────────────────────────────

export function buildComposedRetrievalScope(
  store: KnowledgeStore,
  capsuleSetId: CapsuleSetId,
): ComposedRetrievalScope {
  const set = getCapsuleSet(store, capsuleSetId);
  if (set === undefined) {
    throw new KnowledgeNotFoundError(`CapsuleSet not found: ${String(capsuleSetId)}`);
  }
  return composeScopeFromSet(store, set);
}

function composeScopeFromSet(store: KnowledgeStore, set: CapsuleSet): ComposedRetrievalScope {
  const capsules = loadMemberCapsules(store, set.capsuleIds);
  const sourceIds = collectUniqueSourceIds(capsules);
  const alwaysQueryCapsuleIds = capsules.filter((c) => c.alwaysQuery === true).map((c) => c.id);
  const routingMap = new Map<KnowledgeCapsuleId, string>();
  for (const capsule of capsules) {
    validateSourceRoutingForCapsule(capsule, listCapsuleSources(store, capsule.id));
    if (capsule.sourceRoutingInstructions !== undefined) {
      routingMap.set(capsule.id, capsule.sourceRoutingInstructions);
    }
  }
  return {
    capsuleSetId: set.id,
    capsuleIds: set.capsuleIds,
    capsules,
    sourceIds,
    alwaysQueryCapsuleIds,
    sourceRoutingByCapsule: routingMap,
  };
}

function loadMemberCapsules(
  store: KnowledgeStore,
  ids: readonly KnowledgeCapsuleId[],
): readonly KnowledgeCapsule[] {
  const out: KnowledgeCapsule[] = [];
  for (const id of ids) {
    const capsule = getCapsule(store, id);
    if (capsule !== undefined) out.push(capsule);
  }
  return out;
}

function collectUniqueSourceIds(
  capsules: readonly KnowledgeCapsule[],
): readonly KnowledgeSourceId[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceId[] = [];
  for (const capsule of capsules) {
    for (const sid of capsule.sourceIds) {
      const key = String(sid);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(sid);
      }
    }
  }
  return out;
}

// ─── describeRetrievalScope ─────────────────────────────────────────────────────

export function describeRetrievalScope(
  scope: ComposedRetrievalScope,
  store: KnowledgeStore,
): RetrievalScopeDisclosure {
  const alwaysQuerySet = new Set<string>(scope.alwaysQueryCapsuleIds.map(String));
  const capsuleSummaries: RetrievalCapsuleSummary[] = [];
  const sourceSummaries: RetrievalSourceSummary[] = [];
  for (const capsuleId of scope.capsuleIds) {
    const capsule = getCapsule(store, capsuleId);
    if (capsule === undefined) continue;
    const sources = listCapsuleSources(store, capsuleId);
    capsuleSummaries.push({
      id: capsule.id,
      displayName: capsule.displayName,
      sourceCount: sources.length,
      alwaysQuery: alwaysQuerySet.has(String(capsule.id)),
    });
    for (const source of sources) {
      sourceSummaries.push(summariseSource(source, capsule.id));
    }
  }
  return {
    capsuleSetId: scope.capsuleSetId,
    capsuleSummaries,
    sourceSummaries,
  };
}

function summariseSource(
  source: KnowledgeSource,
  capsuleId: KnowledgeCapsuleId,
): RetrievalSourceSummary {
  return {
    id: source.id,
    displayName: source.displayName,
    capsuleId,
    scopeKind: source.scope.kind,
  };
}

// ─── addSourcesToCapsule ────────────────────────────────────────────────────────

const TOUCH_UPDATED_AT_SQL = "UPDATE capsules SET updated_at = :now WHERE id = :id";
const INSERT_AUDIT_SQL =
  "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, source_id, details_json, occurred_at) VALUES (:id, :capsule_id, :change_kind, :source_id, :details_json, :occurred_at)";

export function addSourcesToCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  inputs: readonly AddCapsuleSourceInput[],
): AddSourcesToCapsuleResult {
  if (inputs.length === 0) {
    throw new CompositionError(
      "empty-source-batch",
      `addSourcesToCapsule called with an empty source list for capsule ${String(capsuleId)}.`,
    );
  }
  assertNoDuplicateInputIds(inputs);
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) {
    throw new KnowledgeNotFoundError(`Capsule not found: ${String(capsuleId)}`);
  }
  assertNoneAlreadyLinked(store, capsuleId, inputs);
  assertSafeSourceInputs(inputs);
  return runAddSourcesTransaction(store, capsuleId, inputs);
}

function assertSafeSourceInputs(inputs: readonly AddCapsuleSourceInput[]): void {
  for (const input of inputs) {
    assertSafeDisplayField("displayName", input.displayName);
    assertSafeOptionalDisplayField("description", input.description);
    for (const tag of input.tags) {
      assertSafeDisplayField("tag", tag);
    }
    const result = validateKnowledgeSourceScope(input.scope);
    if (!result.ok) {
      throw new KnowledgeStoreError(result.errors.join(" "));
    }
  }
}

function assertNoDuplicateInputIds(inputs: readonly AddCapsuleSourceInput[]): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = String(input.id);
    if (seen.has(key)) {
      throw new CompositionError(
        "duplicate-source-in-batch",
        `Source id ${key} appears more than once in the batch.`,
      );
    }
    seen.add(key);
  }
}

function assertNoneAlreadyLinked(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  inputs: readonly AddCapsuleSourceInput[],
): void {
  const existing = new Set(listCapsuleSources(store, capsuleId).map((s) => String(s.id)));
  for (const input of inputs) {
    if (existing.has(String(input.id))) {
      throw new CompositionError(
        "source-already-linked",
        `Source ${String(input.id)} is already linked to capsule ${String(capsuleId)}.`,
      );
    }
  }
}

function runAddSourcesTransaction(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  inputs: readonly AddCapsuleSourceInput[],
): AddSourcesToCapsuleResult {
  const db = store._internal.db;
  const now = store._internal.now();
  // addSourceToCapsule already opens its own BEGIN/COMMIT — we cannot nest. Instead we
  // open ONE explicit transaction here and bypass the per-source helper, inlining the
  // insert against the same `capsule_sources` table.
  db.exec("BEGIN");
  try {
    // KEIKO-0246: use the same INSERT text and scope serialiser as source-lifecycle.ts's
    // single-row addSourceToCapsule path so a future schema/serialiser change applied there
    // automatically propagates to this batch path — the two must stay one implementation.
    const insertKnowledgeSource = db.prepare(INSERT_KNOWLEDGE_SOURCE_SQL);
    const insertSource = db.prepare(INSERT_SQL);
    const insertAudit = db.prepare(INSERT_AUDIT_SQL);
    for (const input of inputs) {
      const params = {
        id: input.id,
        display_name: input.displayName,
        description: input.description ?? null,
        tags_json: JSON.stringify(input.tags),
        scope_kind: input.scope.kind,
        scope_json: scopeToJson(input.scope),
        created_at: now,
        updated_at: now,
      };
      insertKnowledgeSource.run(params);
      insertSource.run({ ...params, capsule_id: capsuleId });
      insertAudit.run({
        id: randomUUID(),
        capsule_id: capsuleId,
        change_kind: "add-source",
        source_id: input.id,
        details_json: null,
        occurred_at: now,
      });
    }
    db.prepare(TOUCH_UPDATED_AT_SQL).run({ now, id: capsuleId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    capsuleId,
    addedSourceIds: inputs.map((i) => i.id),
  };
}

// ─── composeCapsules ────────────────────────────────────────────────────────────

export function composeCapsules(store: KnowledgeStore, opts: ComposeCapsulesOptions): CapsuleSet {
  if (opts.capsuleIds.length === 0) {
    throw new CompositionError(
      "empty-capsule-list",
      "composeCapsules requires at least one capsule id.",
    );
  }
  assertNoDuplicateCapsuleIds(opts.capsuleIds);
  // Verify EVERY capsule id resolves BEFORE we open the CapsuleSet transaction. The
  // create+audit pair must be atomic; failing partway through with the set already on
  // disk would leave a dangling reference.
  const members: KnowledgeCapsule[] = [];
  for (const id of opts.capsuleIds) {
    const exists = getCapsule(store, id);
    if (exists === undefined) {
      throw new KnowledgeNotFoundError(`Capsule not found: ${String(id)}`);
    }
    members.push(exists);
  }
  assertCompatibleMemberEmbeddingIdentities(members);
  return runComposeTransaction(store, opts);
}

// Reuses the ONE embedding-space comparison the retrieval and summary layers already key off
// (`compareEmbeddingProfiles`, keiko-contracts) rather than re-deriving an identity tuple here — a
// second comparison that drifts is a silent fail-open, since vectors from different spaces would be
// treated as comparable.
//
// Policy posture is deliberately NOT part of this profile: a sealed pod that denies external
// embeddings would compare `unavailable` against every other member and make composition impossible
// for a reason that has nothing to do with the embedding space. Locality and query-embedding
// capability are therefore fixed here, leaving only the space itself under comparison.
function memberEmbeddingProfile(
  capsule: KnowledgeCapsule,
): ReturnType<typeof embeddingProfileFromModelIdentity> {
  return embeddingProfileFromModelIdentity(capsule.embeddingModelIdentity, {
    locality: "provider",
    policyCapabilities: ["query-embedding"],
  });
}

// A Knowledge Pod Set answers by expanding into its members and fusing their evidence. Members in
// different embedding spaces cannot do that coherently: each member's dense lane fails closed under
// the other's query identity, so the set degrades to lexical-only grounding while still presenting
// itself as a usable grounding source. Refuse at composition time.
//
// Only a GENUINE incompatibility refuses. `unknown` (an unverified legacy profile) and `opaque` stay
// composable — the pod summary already surfaces them as reindex-recommended guidance, and escalating
// them here would make every pre-hardening pod uncomposable.
function assertCompatibleMemberEmbeddingIdentities(members: readonly KnowledgeCapsule[]): void {
  const profiles = members.map((capsule) => memberEmbeddingProfile(capsule));
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const decision = compareEmbeddingProfiles(profiles[left], profiles[right]);
      if (decision.status !== "incompatible") continue;
      throw new CompositionError(
        "incompatible-embedding-identity",
        `Knowledge Pod Set members must share one embedding identity: ${String(
          members[left]?.id,
        )} and ${String(members[right]?.id)} differ (${decision.reason}). Reindex one of them into the other's embedding space, or compose them as separate sets.`,
      );
    }
  }
}

function assertNoDuplicateCapsuleIds(ids: readonly KnowledgeCapsuleId[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const key = String(id);
    if (seen.has(key)) {
      throw new CompositionError(
        "duplicate-capsule-in-batch",
        `Capsule id ${key} appears more than once in the composition request.`,
      );
    }
    seen.add(key);
  }
}

function runComposeTransaction(store: KnowledgeStore, opts: ComposeCapsulesOptions): CapsuleSet {
  // A single BEGIN/COMMIT wraps both the CapsuleSet write and the audit rows so a crash
  // between them cannot leave a set with no audit trail. `createCapsuleSetWithinTxn` skips
  // its own BEGIN/COMMIT to make this nesting possible (SQLite forbids nested transactions).
  const setInput = buildCreateCapsuleSetInput(opts);
  const db = store._internal.db;
  const now = store._internal.now();
  db.exec("BEGIN");
  try {
    createCapsuleSetWithinTxn(store, setInput, now);
    const details = JSON.stringify({ setId: String(setInput.id) });
    const stmt = db.prepare(INSERT_AUDIT_SQL);
    for (const capsuleId of opts.capsuleIds) {
      stmt.run({
        id: randomUUID(),
        capsule_id: capsuleId,
        change_kind: "compose-set",
        source_id: null,
        details_json: details,
        occurred_at: now,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const set = getCapsuleSet(store, setInput.id);
  if (set === undefined) {
    throw new Error(`runComposeTransaction: row not found after commit for ${String(setInput.id)}`);
  }
  return set;
}

function buildCreateCapsuleSetInput(
  opts: ComposeCapsulesOptions,
): Parameters<typeof createCapsuleSet>[1] {
  const id = randomUUID() as CapsuleSetId;
  const base: Parameters<typeof createCapsuleSet>[1] = {
    id,
    displayName: opts.displayName,
    tags: opts.tags ?? [],
    capsuleIds: opts.capsuleIds,
  };
  return opts.description !== undefined ? { ...base, description: opts.description } : base;
}

// ─── listCapsuleMembershipChanges ───────────────────────────────────────────────

interface AuditRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly change_kind: string;
  readonly source_id: string | null;
  readonly details_json: string | null;
  readonly occurred_at: number;
}

const SELECT_AUDIT_SQL =
  "SELECT id, capsule_id, change_kind, source_id, details_json, occurred_at FROM capsule_membership_changes WHERE capsule_id = :c ORDER BY occurred_at ASC, id ASC";

export function listCapsuleMembershipChanges(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly CapsuleMembershipChange[] {
  const rows = store._internal.db.prepare(SELECT_AUDIT_SQL).all({ c: capsuleId });
  return rows.map((row) => mapAuditRow(row as unknown as AuditRow));
}

function mapAuditRow(row: AuditRow): CapsuleMembershipChange {
  return {
    id: row.id,
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    changeKind: row.change_kind as CapsuleMembershipChangeKind,
    sourceId: row.source_id === null ? undefined : (row.source_id as KnowledgeSourceId),
    detailsJson: row.details_json ?? undefined,
    occurredAt: row.occurred_at,
  };
}
