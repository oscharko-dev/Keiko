import {
  CODING_WORKBENCH_MODES,
  MEMORY_AUDIT_INITIATOR_SURFACES,
  MEMORY_SOURCE_KINDS,
  type CodingWorkbenchMode,
  type MemoryAuditEvent,
  type MemoryAuditInitiatorSurface,
  type MemoryId,
  type MemoryRecord,
  type MemoryScope,
  type MemorySourceKind,
  type MemoryStatus,
  validateMemoryScope,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RejectionReason } from "@oscharko-dev/keiko-memory-capture";
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

const CAPTURE_DECISION_OUTCOMES: readonly MemoryCaptureDecisionOutcome[] = [
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
  "empty-content",
  "exceeds-length-limit",
  "ambiguous-forget",
  "ambiguous-update",
  "restricted-sensitivity",
  "sensitive-memory-requires-approval",
  "suppressed-by-forget",
  "scope-not-resolvable",
] as const satisfies readonly RejectionReason[];

const CAPTURE_SETTLEMENT_REASONS = [
  "captured-by-policy",
  "mode-requires-approval",
  "sensitivity-requires-approval",
  "governance-promotion-deferred",
  "governance-auto-accepted",
] as const;

export type MemoryCaptureDecisionReason =
  RejectionReason | (typeof CAPTURE_SETTLEMENT_REASONS)[number];

const CAPTURE_DECISION_REASONS: readonly MemoryCaptureDecisionReason[] = [
  ...CAPTURE_REJECTION_REASONS,
  ...CAPTURE_SETTLEMENT_REASONS,
];

export interface MemoryCaptureDecisionProvenance {
  readonly initiatorSurface: MemoryAuditInitiatorSurface;
  readonly sourceKind: MemorySourceKind;
}

export interface MemoryCaptureDecision {
  readonly eventId: string;
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly scope: MemoryScope;
  readonly mode: CodingWorkbenchMode;
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

function projectEvent(
  event: MemoryAuditEvent,
  ledgerOrder: number,
  options: MemoryCaptureProjectionOptions,
  allowedScopeKeys: ReadonlySet<string>,
  liveById: ReadonlyMap<MemoryId, MemoryRecord>,
  forgotten: ReadonlySet<MemoryId>,
): IndexedDecision | null {
  if (
    event.occurredAt < options.since ||
    !TURN_CAPTURE_INITIATOR_SURFACES.has(event.initiatorSurface)
  ) {
    return null;
  }
  if (!isCaptureAuditEvent(event)) return null;
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
