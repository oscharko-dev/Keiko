import type {
  CodingWorkbenchMode,
  MemoryAuditEvent,
  MemoryAuditInitiatorSurface,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  MEMORY_AUDIT_INITIATOR_SURFACES,
  MEMORY_SOURCE_KINDS,
  validateMemoryScope,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RejectionReason, SalienceDropReason } from "@oscharko-dev/keiko-memory-capture";
import { auditRunIdFor, RUNID_PREFIX, verifyMemoryAuditHashChain } from "./memory-audit-handler.js";
import { memoryScopeKey, sanitizeMemoryScope } from "./memory-scope-sanitizer.js";

const CAPTURE_DECISION_SUMMARY_PREFIX = "capture-decision:v1";

// Turn-capture decisions originate from exactly these two initiator surfaces (desktop chat and
// realtime voice, per #2550) -- every other MemoryAuditInitiatorSurface value (memory-center,
// workflow, consolidation, retention, system) belongs to a different audit-event family and must
// stay excluded from this projection.
const TURN_CAPTURE_INITIATOR_SURFACES: ReadonlySet<MemoryAuditInitiatorSurface> = new Set([
  "conversation-center",
  "voice",
]);

export type MemoryCaptureDecisionOutcome = "captured" | "proposed" | "auto-accepted" | "rejected";

export const CAPTURE_DECISION_OUTCOMES: readonly MemoryCaptureDecisionOutcome[] = [
  "captured",
  "proposed",
  "auto-accepted",
  "rejected",
];

const CAPTURE_REJECTION_REASONS = [
  "credential-shape",
  "private-credential-path",
  "provider-base-url",
  "raw-log-content",
  "customer-identifier",
  "denied-category",
  "instruction-override",
  "empty-content",
  "exceeds-length-limit",
  "ambiguous-forget",
  "ambiguous-update",
  "forget-reference-unresolved",
  "restricted-sensitivity",
  "sensitive-memory-requires-approval",
  "suppressed-by-forget",
  "suppressed-by-rejection",
  "scope-not-resolvable",
] as const satisfies readonly RejectionReason[];

const CAPTURE_SETTLEMENT_REASONS = [
  "captured-by-policy",
  // Historical: before #4206 the selected mode held a routine fact. Replayed, never written again.
  "mode-requires-approval",
  // An operator explicitly restricted Memory to review (#4206).
  "operator-requires-approval",
  "sensitivity-requires-approval",
  "governance-promotion-deferred",
  "governance-auto-accepted",
  // Projected only, from the vault's own forget event; never written as a capture decision.
  "forgotten-by-person",
] as const;

// What the learner refused to keep from a conversation because of its content: a fact about
// someone else, a personal identifier, or denied content (#4206). A non-fact (a question, a request)
// is no decision about the person's data and stays on the Activity Log only.
export const LEARNED_REFUSAL_REASONS = [
  "third-party",
  "personal-identifier",
  "denied-content",
] as const satisfies readonly SalienceDropReason[];

export type LearnedRefusalReason = (typeof LEARNED_REFUSAL_REASONS)[number];

export type MemoryCaptureDecisionReason =
  RejectionReason | LearnedRefusalReason | (typeof CAPTURE_SETTLEMENT_REASONS)[number];

export const CAPTURE_DECISION_REASONS: readonly MemoryCaptureDecisionReason[] = [
  ...CAPTURE_REJECTION_REASONS,
  ...LEARNED_REFUSAL_REASONS,
  ...CAPTURE_SETTLEMENT_REASONS,
];

export interface MemoryCaptureDecisionProvenance {
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly sourceKind: MemorySourceKind;
}

// What the Journal shows: every capture decision, and every memory the person forgot (#4206). A
// forget is projected from the vault's own `memory:forgotten` event, so it needs no second writer.
export type MemoryJournalOutcome = MemoryCaptureDecisionOutcome | "forgotten";

export interface MemoryCaptureDecision {
  readonly eventId: string;
  readonly outcome: MemoryJournalOutcome;
  readonly scope: MemoryScope;
  // Absent for a forget: forgetting acts in every mode, so no mode decided it.
  readonly mode?: CodingWorkbenchMode;
  readonly provenance: MemoryCaptureDecisionProvenance;
  readonly occurredAt: number;
  readonly reason: MemoryCaptureDecisionReason;
  readonly memoryId?: string;
  // The record's CURRENT status, not the capture-time one. `outcome` is audit history and is never
  // rewritten; a record proposed at capture can afterwards be accepted (review queue, detail view,
  // maintenance sweep), archived, or superseded. Present exactly when `memoryId` is — a decision
  // without a live record is either a record-free rejection or already dropped. Body-free: a
  // contract enum, no record content.
  readonly currentStatus?: MemoryStatus;
}

export interface BuildMemoryCaptureDecisionAuditEventInput {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly scope: MemoryScope;
  readonly mode: CodingWorkbenchMode;
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly sourceKind: MemorySourceKind;
  readonly reason: MemoryCaptureDecisionReason;
  readonly memoryId?: MemoryId;
}

interface ParsedCaptureDecisionSummary {
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly mode: CodingWorkbenchMode;
  readonly sourceKind: MemorySourceKind;
  readonly recordPresent: boolean;
  readonly reason: MemoryCaptureDecisionReason;
}

export interface MemoryCaptureProjectionOptions {
  readonly since: number;
  readonly order: "asc" | "desc";
  readonly authorizedScopes: readonly MemoryScope[];
  readonly liveRecords: readonly MemoryRecord[];
}

interface IndexedDecision {
  readonly decision: MemoryCaptureDecision;
  readonly ledgerOrder: number;
}

export class MemoryCaptureProjectionReadError extends Error {
  public constructor() {
    super("Memory capture audit evidence could not be replayed safely.");
    this.name = "MemoryCaptureProjectionReadError";
  }
}

function isMember<T extends string>(value: string | undefined, values: readonly T[]): value is T {
  return value !== undefined && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureDecisionSummary(input: BuildMemoryCaptureDecisionAuditEventInput): string {
  const recordFlag = input.memoryId === undefined ? "none" : "present";
  return [
    CAPTURE_DECISION_SUMMARY_PREFIX,
    input.outcome,
    input.mode,
    input.sourceKind,
    recordFlag,
    input.reason,
  ].join("|");
}

function eventKindForOutcome(
  outcome: MemoryCaptureDecisionOutcome,
): "memory:accepted" | "memory:proposed" | "memory:rejected" {
  switch (outcome) {
    case "captured":
    case "auto-accepted":
      return "memory:accepted";
    case "proposed":
      return "memory:proposed";
    case "rejected":
      return "memory:rejected";
  }
}

export function buildMemoryCaptureDecisionAuditEvent(
  input: BuildMemoryCaptureDecisionAuditEventInput,
): MemoryAuditEvent {
  const envelope = {
    schemaVersion: "1" as const,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    initiatorSurface: input.initiatorSurface,
    summary: captureDecisionSummary(input),
    memoryId: input.memoryId ?? (input.eventId as MemoryId),
    scope: input.scope,
  };
  switch (eventKindForOutcome(input.outcome)) {
    case "memory:accepted":
      return { ...envelope, kind: "memory:accepted" };
    case "memory:proposed":
      return { ...envelope, kind: "memory:proposed" };
    case "memory:rejected":
      return { ...envelope, kind: "memory:rejected" };
  }
}

function parseCaptureDecisionSummary(summary: string): ParsedCaptureDecisionSummary | null {
  const [prefix, outcome, mode, sourceKind, recordFlag, reason, extra] = summary.split("|");
  if (prefix !== CAPTURE_DECISION_SUMMARY_PREFIX || extra !== undefined) return null;
  if (!isMember(outcome, CAPTURE_DECISION_OUTCOMES)) return null;
  if (!isMember(mode, CODING_WORKBENCH_MODES)) return null;
  if (!isMember(sourceKind, MEMORY_SOURCE_KINDS)) return null;
  if (recordFlag !== "present" && recordFlag !== "none") return null;
  if (!isMember(reason, CAPTURE_DECISION_REASONS)) return null;
  return { outcome, mode, sourceKind, recordPresent: recordFlag === "present", reason };
}

function auditScopeKey(scope: MemoryScope): string {
  return memoryScopeKey(sanitizeMemoryScope(scope, (value) => value));
}

function eventMatchesOutcome(
  event: MemoryAuditEvent,
  outcome: MemoryCaptureDecisionOutcome,
): boolean {
  return event.kind === eventKindForOutcome(outcome);
}

function forgottenMemoryIds(events: readonly MemoryAuditEvent[]): ReadonlySet<MemoryId> {
  const forgotten = new Set<MemoryId>();
  for (const event of events) {
    if (event.kind === "memory:forgotten") forgotten.add(event.memoryId);
  }
  return forgotten;
}

function liveRecordMap(records: readonly MemoryRecord[]): ReadonlyMap<MemoryId, MemoryRecord> {
  return new Map(records.map((record) => [record.id, record]));
}

type CaptureAuditEvent = Extract<
  MemoryAuditEvent,
  { readonly kind: "memory:accepted" | "memory:proposed" | "memory:rejected" }
>;

function isCaptureAuditEvent(event: MemoryAuditEvent): event is CaptureAuditEvent {
  return (
    event.kind === "memory:accepted" ||
    event.kind === "memory:proposed" ||
    event.kind === "memory:rejected"
  );
}

function projectedMemoryId(
  event: CaptureAuditEvent,
  parsed: ParsedCaptureDecisionSummary,
  liveById: ReadonlyMap<MemoryId, MemoryRecord>,
  forgotten: ReadonlySet<MemoryId>,
): string | null | undefined {
  if (!parsed.recordPresent) return parsed.outcome === "rejected" ? undefined : null;
  const live = liveById.get(event.memoryId);
  if (live === undefined || forgotten.has(event.memoryId)) return null;
  if (auditScopeKey(live.scope) !== auditScopeKey(event.scope)) return null;
  return String(event.memoryId);
}

function buildProjectedDecision(
  event: CaptureAuditEvent,
  parsed: ParsedCaptureDecisionSummary,
  memoryId: string | undefined,
  currentStatus: MemoryStatus | undefined,
): MemoryCaptureDecision {
  return {
    eventId: event.eventId,
    outcome: parsed.outcome,
    scope: sanitizeMemoryScope(event.scope, (value) => value),
    mode: parsed.mode,
    provenance: { initiatorSurface: event.initiatorSurface, sourceKind: parsed.sourceKind },
    occurredAt: event.occurredAt,
    reason: parsed.reason,
    ...(memoryId === undefined ? {} : { memoryId }),
    ...(currentStatus === undefined ? {} : { currentStatus }),
  };
}

// A forget that left a tombstone is the person's decision; a deletion without one (a replaced or
// expired record) is housekeeping and stays out. The record is gone, so the entry names none.
// #4206 audit: retention and maintenance also tombstone records. Only a forget a person asked for,
// in the Memory Center or with a clear statement in a Chat, is the person's Journal entry.
const PERSON_FORGETTER_SURFACES: ReadonlySet<string> = new Set(["memory-center", "chat-statement"]);

function isPersonForget(forgetterSurface: string | undefined): boolean {
  return forgetterSurface !== undefined && PERSON_FORGETTER_SURFACES.has(forgetterSurface);
}

function projectForgetEvent(
  event: Extract<MemoryAuditEvent, { readonly kind: "memory:forgotten" }>,
  ledgerOrder: number,
  allowedScopeKeys: ReadonlySet<string>,
): IndexedDecision | null {
  if (!event.tombstoned || !isPersonForget(event.forgetterSurface)) return null;
  if (!allowedScopeKeys.has(auditScopeKey(event.scope))) return null;
  return {
    decision: {
      eventId: event.eventId,
      outcome: "forgotten",
      scope: sanitizeMemoryScope(event.scope, (value) => value),
      provenance: {
        initiatorSurface: event.initiatorSurface,
        sourceKind: "explicit-user-instruction",
      },
      occurredAt: event.occurredAt,
      reason: "forgotten-by-person",
    },
    ledgerOrder,
  };
}

function projectEvent(
  event: MemoryAuditEvent,
  ledgerOrder: number,
  options: MemoryCaptureProjectionOptions,
  allowedScopeKeys: ReadonlySet<string>,
  liveById: ReadonlyMap<MemoryId, MemoryRecord>,
  forgotten: ReadonlySet<MemoryId>,
): IndexedDecision | null {
  if (event.occurredAt < options.since) return null;
  if (event.kind === "memory:forgotten") {
    return projectForgetEvent(event, ledgerOrder, allowedScopeKeys);
  }
  if (!TURN_CAPTURE_INITIATOR_SURFACES.has(event.initiatorSurface)) return null;
  if (!isCaptureAuditEvent(event)) return null;
  return projectCaptureEvent(event, ledgerOrder, allowedScopeKeys, liveById, forgotten);
}

function projectCaptureEvent(
  event: CaptureAuditEvent,
  ledgerOrder: number,
  allowedScopeKeys: ReadonlySet<string>,
  liveById: ReadonlyMap<MemoryId, MemoryRecord>,
  forgotten: ReadonlySet<MemoryId>,
): IndexedDecision | null {
  const parsed = parseCaptureDecisionSummary(event.summary);
  if (parsed === null || !eventMatchesOutcome(event, parsed.outcome)) return null;
  if (!allowedScopeKeys.has(auditScopeKey(event.scope))) return null;
  const memoryId = projectedMemoryId(event, parsed, liveById, forgotten);
  if (memoryId === null) return null;
  const live = memoryId === undefined ? undefined : liveById.get(event.memoryId);
  return {
    decision: buildProjectedDecision(event, parsed, memoryId, live?.status),
    ledgerOrder,
  };
}

function compareIndexedDecisions(
  left: IndexedDecision,
  right: IndexedDecision,
  order: "asc" | "desc",
): number {
  const direction = order === "asc" ? 1 : -1;
  if (left.decision.occurredAt !== right.decision.occurredAt) {
    return direction * (left.decision.occurredAt - right.decision.occurredAt);
  }
  return direction * (left.ledgerOrder - right.ledgerOrder);
}

export function projectMemoryCaptureDecisions(
  events: readonly MemoryAuditEvent[],
  options: MemoryCaptureProjectionOptions,
): readonly MemoryCaptureDecision[] {
  const allowedScopeKeys = new Set(options.authorizedScopes.map(auditScopeKey));
  const liveById = liveRecordMap(options.liveRecords);
  const forgotten = forgottenMemoryIds(events);
  const projected = events.flatMap((event, ledgerOrder): IndexedDecision[] => {
    const decision = projectEvent(
      event,
      ledgerOrder,
      options,
      allowedScopeKeys,
      liveById,
      forgotten,
    );
    return decision === null ? [] : [decision];
  });
  projected.sort((left, right) => compareIndexedDecisions(left, right, options.order));
  return projected.map(({ decision }) => decision);
}

function isRelevantAuditKind(
  value: unknown,
): value is "memory:accepted" | "memory:proposed" | "memory:rejected" | "memory:forgotten" {
  return (
    value === "memory:accepted" ||
    value === "memory:proposed" ||
    value === "memory:rejected" ||
    value === "memory:forgotten"
  );
}

function hasValidAuditIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "1" &&
    typeof value.eventId === "string" &&
    typeof value.summary === "string" &&
    typeof value.memoryId === "string"
  );
}

function hasValidOccurredAt(value: Record<string, unknown>): boolean {
  return (
    typeof value.occurredAt === "number" &&
    Number.isSafeInteger(value.occurredAt) &&
    value.occurredAt >= 0
  );
}

function hasValidInitiatorSurface(value: Record<string, unknown>): boolean {
  const surface = typeof value.initiatorSurface === "string" ? value.initiatorSurface : undefined;
  return isMember(surface, MEMORY_AUDIT_INITIATOR_SURFACES);
}

function hasValidRelevantAuditEnvelope(value: Record<string, unknown>): boolean {
  return (
    hasValidAuditIdentity(value) &&
    hasValidOccurredAt(value) &&
    hasValidInitiatorSurface(value) &&
    validateMemoryScope(value.scope).ok
  );
}

function parseRelevantAuditEvent(value: unknown): MemoryAuditEvent | null {
  if (!isRecord(value) || !isRelevantAuditKind(value.kind)) return null;
  if (!hasValidRelevantAuditEnvelope(value)) throw new MemoryCaptureProjectionReadError();
  if (value.kind === "memory:forgotten" && typeof value.tombstoned !== "boolean") {
    throw new MemoryCaptureProjectionReadError();
  }
  return value as unknown as MemoryAuditEvent;
}

function parseAuditManifest(json: string): readonly MemoryAuditEvent[] {
  if (!verifyMemoryAuditHashChain(json).ok) throw new MemoryCaptureProjectionReadError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MemoryCaptureProjectionReadError();
  }
  if (!Array.isArray(parsed)) throw new MemoryCaptureProjectionReadError();
  return parsed.flatMap((value): MemoryAuditEvent[] => {
    const event = parseRelevantAuditEvent(value);
    return event === null ? [] : [event];
  });
}

function relevantAuditRunIds(store: EvidenceStore, since: number): readonly string[] {
  const firstRunId = auditRunIdFor(since);
  return store
    .list()
    .filter((runId) => runId.startsWith(RUNID_PREFIX) && runId >= firstRunId)
    .sort((left, right) => left.localeCompare(right));
}

export function replayMemoryCaptureAuditLedger(
  store: EvidenceStore,
  since: number,
): readonly MemoryAuditEvent[] {
  try {
    return relevantAuditRunIds(store, since).flatMap((runId) => {
      const json = store.get(runId);
      return json === undefined ? [] : parseAuditManifest(json);
    });
  } catch (error) {
    if (error instanceof MemoryCaptureProjectionReadError) throw error;
    throw new MemoryCaptureProjectionReadError();
  }
}
