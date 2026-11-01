// Requirement inventory of a Chat's Knowledge Pods (#4179, Epic #4173).
//
// The documents of the Pods attached to a Chat are read whole under the scope and policy retrieval
// itself resolves, and the deterministic Quality Intelligence inventory detects their requirement
// units. The `knowledge.requirements` read tool pages those units to the model; the trace of a
// created or edited Jira item is validated against the same units. Nothing here ranks, routes by
// keyword or decides for the model when it needs a complete list.

import { createHash } from "node:crypto";

import type { UiHandlerDeps } from "./deps.js";
import { currentContentRedactor } from "./content-redactor.js";
import type {
  CapsuleSetId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { Chat } from "@oscharko-dev/keiko-contracts/bff-wire";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  QualityIntelligenceHandoff,
  resolveEnumerationScope,
  resolveScopeModelUsePolicy,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  REQUIREMENT_INVENTORY_ENTRIES_MAX,
  assessRequirementInventoryQuality,
  deriveRequirementInventory,
  requirementReference,
  type RequirementInventoryEntry,
  type RequirementTraceUnit,
} from "@oscharko-dev/keiko-quality-intelligence";

/** Units kept per read; more are counted, never silently dropped. */
export const REQUIREMENT_UNITS_MAX = 5000;

export interface RequirementScopeQuery {
  readonly capsuleId?: KnowledgeCapsuleId | undefined;
  readonly capsuleSetId?: CapsuleSetId | undefined;
}

/** The Pods of a Chat: the plural list supersedes the legacy single scope, never both. */
export function chatKnowledgeScopes(chat: Chat | undefined): readonly RequirementScopeQuery[] {
  const scopes =
    chat?.localKnowledgeScopes ?? (chat?.localKnowledgeScope ? [chat.localKnowledgeScope] : []);
  return scopes.map((scope) =>
    scope.kind === "capsule"
      ? { capsuleId: scope.capsuleId }
      : { capsuleSetId: scope.capsuleSetId },
  );
}

export type ScopeRefusal =
  "scope-unavailable" | "indexing" | "stale" | "error" | "not-ready" | "policy-denied";

/** A scope grounded answers would refuse is refused here too: same lifecycle and policy floor. */
export function scopeRefusal(capsules: readonly KnowledgeCapsule[]): ScopeRefusal | undefined {
  const states = new Set(capsules.map((capsule) => capsule.lifecycleState));
  if (states.has("indexing")) return "indexing";
  if (states.has("stale")) return "stale";
  if (states.has("error")) return "error";
  if (capsules.some((capsule) => capsule.lifecycleState !== "ready")) return "not-ready";
  const operations = resolveScopeModelUsePolicy(capsules).operations;
  return operations.answerSynthesis === "deny" || operations.rawContentRelease === "deny"
    ? "policy-denied"
    : undefined;
}

export type RequirementCutReason =
  "unit-bound" | "document-bound" | "document-text-bound" | "scope-refused";

/** A detected unit with what is needed to locate it again in its document. */
export interface LocatedRequirementUnit extends RequirementTraceUnit {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: string;
}

export interface RequirementDocumentSummary {
  readonly documentScope: string;
  readonly name: string;
  readonly digest: string;
  readonly unitCount: number;
}

export interface RequirementCollection {
  readonly units: readonly LocatedRequirementUnit[];
  readonly documents: readonly RequirementDocumentSummary[];
  readonly documentsScanned: number;
  readonly documentsNotExtracted: number;
  readonly documentsOmitted: number;
  readonly unitsOmitted: number;
  readonly cutReasons: readonly RequirementCutReason[];
  readonly refusals: readonly ScopeRefusal[];
  /** Identifiers defined with different content, per document scope. */
  readonly conflictingIds: readonly string[];
  /** Identifiers that exist in more than one document: they need their document scope. */
  readonly ambiguousIds: readonly string[];
  readonly referenceOnlyCount: number;
  readonly rejectedCandidateCount: number;
}

interface Accumulator {
  units: LocatedRequirementUnit[];
  documents: RequirementDocumentSummary[];
  documentsScanned: number;
  documentsNotExtracted: number;
  documentsOmitted: number;
  unitsOmitted: number;
  cuts: Set<RequirementCutReason>;
  refusals: ScopeRefusal[];
  conflicting: Set<string>;
  referenceOnly: number;
  rejected: number;
}

function readDocument(
  accumulator: Accumulator,
  document: QualityIntelligenceHandoff.ScopeDocument,
): void {
  const room = REQUIREMENT_UNITS_MAX - accumulator.units.length;
  const inventory = deriveRequirementInventory({
    text: document.text,
    sections: document.sections,
    documentKey: String(document.documentId),
    maxEntries: Math.max(1, Math.min(room, REQUIREMENT_INVENTORY_ENTRIES_MAX * 10)),
  });
  const entries = inventory.entries.slice(0, Math.max(0, room));
  const findings = assessRequirementInventoryQuality(entries);
  const source = { documentName: document.displayName, documentDigest: document.contentHash };
  for (const entry of entries)
    accumulator.units.push({
      entry,
      source,
      findings: findings.get(entry.id) ?? [],
      capsuleId: document.capsuleId,
      documentId: String(document.documentId),
    });
  accumulator.unitsOmitted += inventory.totalCount - entries.length;
  if (inventory.totalCount > entries.length) accumulator.cuts.add("unit-bound");
  for (const id of inventory.conflictingIds) accumulator.conflicting.add(id);
  accumulator.referenceOnly += inventory.referenceOnlyCount;
  accumulator.rejected += inventory.rejectedCandidateCount;
  accumulator.documents.push({
    documentScope: entries[0]?.documentScope ?? documentScopeFallback(document),
    name: document.displayName,
    digest: document.contentHash,
    unitCount: entries.length,
  });
}

function documentScopeFallback(document: QualityIntelligenceHandoff.ScopeDocument): string {
  return createHash("sha256")
    .update(`keiko-document|${String(document.documentId)}`)
    .digest("hex")
    .slice(0, 8);
}

function readScope(
  store: KnowledgeStore,
  query: RequirementScopeQuery,
  accumulator: Accumulator,
): void {
  const resolved = resolveEnumerationScope(store, {
    ...(query.capsuleId === undefined ? {} : { capsuleId: query.capsuleId }),
    ...(query.capsuleSetId === undefined ? {} : { capsuleSetId: query.capsuleSetId }),
  });
  if (!resolved.ok) {
    accumulator.refusals.push("scope-unavailable");
    accumulator.cuts.add("scope-refused");
    return;
  }
  const refusal = scopeRefusal(resolved.scope.capsules ?? []);
  if (refusal !== undefined) {
    accumulator.refusals.push(refusal);
    accumulator.cuts.add("scope-refused");
    return;
  }
  const read = QualityIntelligenceHandoff.readScopeDocuments(store, {
    capsuleIds: resolved.scope.capsuleIds,
    sourceFilter: resolved.scope.sourceFilter,
  });
  accumulator.documentsNotExtracted += read.notExtractedDocumentCount;
  accumulator.documentsScanned += read.documents.length;
  accumulator.documentsOmitted += read.omittedByCountCount + read.omittedByTextCount;
  if (read.omittedByCountCount > 0) accumulator.cuts.add("document-bound");
  if (read.omittedByTextCount > 0) accumulator.cuts.add("document-text-bound");
  for (const document of read.documents) readDocument(accumulator, document);
}

function ambiguousIdsOf(units: readonly LocatedRequirementUnit[]): readonly string[] {
  const scopes = new Map<string, Set<string>>();
  for (const unit of units) {
    const set = scopes.get(unit.entry.id) ?? new Set<string>();
    scopes.set(unit.entry.id, set.add(unit.entry.documentScope));
  }
  return [...scopes]
    .filter(([, set]) => set.size > 1)
    .map(([id]) => id)
    .sort(compareStrings);
}

/** Every requirement unit the Chat's Pods hold, in a stable order, with honest totals. */
export function collectRequirementUnits(
  store: KnowledgeStore,
  scopes: readonly RequirementScopeQuery[],
): RequirementCollection {
  const accumulator: Accumulator = {
    units: [],
    documents: [],
    documentsScanned: 0,
    documentsNotExtracted: 0,
    documentsOmitted: 0,
    unitsOmitted: 0,
    cuts: new Set(),
    refusals: [],
    conflicting: new Set(),
    referenceOnly: 0,
    rejected: 0,
  };
  for (const scope of scopes) readScope(store, scope, accumulator);
  return Object.freeze({
    units: accumulator.units,
    documents: accumulator.documents,
    documentsScanned: accumulator.documentsScanned,
    documentsNotExtracted: accumulator.documentsNotExtracted,
    documentsOmitted: accumulator.documentsOmitted,
    unitsOmitted: accumulator.unitsOmitted,
    cutReasons: [...accumulator.cuts].sort(compareStrings),
    refusals: accumulator.refusals,
    conflictingIds: [...accumulator.conflicting].sort(compareStrings),
    ambiguousIds: ambiguousIdsOf(accumulator.units),
    referenceOnlyCount: accumulator.referenceOnly,
    rejectedCandidateCount: accumulator.rejected,
  });
}

/** The page label of the chunk that covers a unit, read on demand for the units a call returns. */
export function pageLabelOf(
  store: KnowledgeStore,
  unit: LocatedRequirementUnit,
): string | undefined {
  const reference = QualityIntelligenceHandoff.referenceForSpan(
    store,
    { capsuleId: unit.capsuleId, documentId: unit.documentId as never },
    { characterStart: unit.entry.characterStart, characterEnd: unit.entry.characterEnd },
  );
  const citation = reference?.citation;
  return (
    citation?.pageLabel ??
    (citation?.pageNumber === undefined ? undefined : String(citation.pageNumber))
  );
}

// ─── Selection and paging ────────────────────────────────────────────────────

export interface RequirementFilter {
  /** Document scopes (the 8-hex ids a `documents` view lists). */
  readonly documents?: readonly string[] | undefined;
  readonly query?: string | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly priorities?: readonly string[] | undefined;
}

function matchesQuery(entry: RequirementInventoryEntry, needle: string): boolean {
  const haystack = [entry.id, entry.title, entry.statement, ...entry.sectionPath].join("\n");
  return haystack.toLowerCase().includes(needle);
}

export function selectUnits(
  units: readonly LocatedRequirementUnit[],
  filter: RequirementFilter,
): readonly LocatedRequirementUnit[] {
  const needle = filter.query?.trim().toLowerCase();
  const wantedIds = filter.ids === undefined ? undefined : new Set(filter.ids);
  const wantedPriorities =
    filter.priorities === undefined
      ? undefined
      : new Set(filter.priorities.map((priority) => priority.trim().toLowerCase()));
  return units.filter(({ entry }) => {
    if (filter.documents !== undefined && !filter.documents.includes(entry.documentScope))
      return false;
    if (wantedIds !== undefined && !wantedIds.has(entry.id)) return false;
    if (
      wantedPriorities !== undefined &&
      !wantedPriorities.has((entry.priority ?? "").toLowerCase())
    )
      return false;
    return needle === undefined || needle.length === 0 || matchesQuery(entry, needle);
  });
}

/** Binds a cursor to the exact selection it was issued for; a changed document invalidates it. */
export function selectionFingerprint(
  selected: readonly LocatedRequirementUnit[],
  view: string,
): string {
  const hash = createHash("sha256").update(view);
  for (const { entry } of selected) hash.update(`\n${requirementReference(entry)}|${entry.digest}`);
  return hash.digest("hex").slice(0, 16);
}

export interface PageCursor {
  readonly offset: number;
  readonly fingerprint: string;
}

const CURSOR_SHAPE = /^(\d{1,9})\.([0-9a-f]{16})$/u;

export function encodeCursor(cursor: PageCursor): string {
  return `${String(cursor.offset)}.${cursor.fingerprint}`;
}

/** A cursor that does not have the exact shape of an issued one is not a cursor at all. */
export function decodeCursor(value: string): PageCursor | undefined {
  const match = CURSOR_SHAPE.exec(value);
  const [, offset, fingerprint] = match ?? [];
  return offset === undefined || fingerprint === undefined
    ? undefined
    : { offset: Number(offset), fingerprint };
}

export interface PageWindow {
  /** Index range [from, to) of the selection that fits the byte and item bounds. */
  readonly from: number;
  readonly to: number;
}

/**
 * The largest window starting at `from` whose rendered items fit `maxBytes` and `limit`; a single
 * item larger than the bound is still returned alone so a page always advances.
 */
export function fitWindow(
  sizes: readonly number[],
  from: number,
  limit: number,
  maxBytes: number,
): PageWindow {
  let to = from;
  let bytes = 0;
  while (to < sizes.length && to - from < limit) {
    const size = sizes[to] ?? 0;
    if (to > from && bytes + size > maxBytes) break;
    bytes += size;
    to += 1;
  }
  return { from, to };
}

// ─── Per-turn reuse and redaction ────────────────────────────────────────────

const TURN_CACHE_MAX = 8;
const turnCache = new Map<string, RequirementCollection>();

/**
 * The units of a Chat's Pods for one turn: later pages and the trace of the same turn reuse the
 * first read, a new turn reads again so an edited document is never served stale.
 */
export function collectForTurn(
  store: KnowledgeStore,
  scopes: readonly RequirementScopeQuery[],
  chatId: string,
  userMessageId: string | undefined,
): RequirementCollection {
  if (userMessageId === undefined) return collectRequirementUnits(store, scopes);
  const key = `${chatId}|${userMessageId}`;
  const hit = turnCache.get(key);
  if (hit !== undefined) return hit;
  const value = collectRequirementUnits(store, scopes);
  turnCache.set(key, value);
  while (turnCache.size > TURN_CACHE_MAX) {
    const oldest = turnCache.keys().next();
    if (oldest.done === true) break;
    turnCache.delete(oldest.value);
  }
  return value;
}

/** The Chat content policy's redactor as a string function. */
export function contentRedact(deps: UiHandlerDeps): (value: string) => string {
  const redactor = currentContentRedactor(deps);
  return (value) => {
    const redacted = redactor(value);
    return typeof redacted === "string" ? redacted : "";
  };
}

/** Test seam: forget the per-turn reads. */
export function resetRequirementTurnCache(): void {
  turnCache.clear();
}
