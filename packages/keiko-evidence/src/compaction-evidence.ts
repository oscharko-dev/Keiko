// Compaction-record evidence persistence (ADR-0056 W2, D3 chat-path helper). Follows the
// persistConnectedContextEvidence template EXACTLY: build a minimal EvidenceManifest carrying the
// compaction[] records -> field-level redact every string in the records (Layer 1) -> whole-object
// deepRedactStrings (Layer 2, defense in depth) -> store.put -> applyRetention -> return the
// redacted manifest + location. The compaction bodies are already secret-scanned upstream (PR2/PR4);
// the two passes here are additional defense in depth. This helper is contract-ready but NOT wired
// to any live request handler in PR5 (the chat-turn wire is PR6). workspaceRoot is hashed to an
// audit id so no raw absolute path ever enters the manifest.

import { createHash } from "node:crypto";

import {
  HARNESS_VERSION,
  type ContextCommandOutcome,
  type ContextCompactionRecord,
  type ContextInvalidationKey,
  type ContextPreservedFact,
  type ContextProvenanceRef,
  type ContextAssumption,
  type ContextUserConstraint,
  type CostClass,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-security";
import { buildEvidenceReport, type EvidenceReport } from "./report.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import { applyRetention } from "./retention.js";
import { assertValidRunId } from "./runid.js";
import {
  DEFAULT_RETENTION,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceManifest,
  type EvidenceStore,
  type RetentionPolicy,
} from "./types.js";

type Redactor = (input: string) => string;

export interface CompactionEvidenceInput {
  readonly runId: string;
  readonly modelId: string;
  readonly records: readonly ContextCompactionRecord[];
  readonly startedAt: number;
  readonly finishedAt: number;
  // Optional absolute workspace root; hashed to an audit id. Omitted on the chat path, which is not
  // scoped to a single workspace per turn (ADR-0056 Consequences/Neutral).
  readonly workspaceRoot?: string | undefined;
  // SHA-256 of the chat id, pre-computed by the caller (never the raw id).
  readonly chatIdHash?: string | undefined;
}

export interface CompactionEvidenceContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
  readonly additionalSecrets?: readonly string[] | undefined;
  readonly costClassResolver?: ((modelId: string) => CostClass | "unknown") | undefined;
  readonly retention?: RetentionPolicy | undefined;
}

export interface CompactionEvidencePersistResult {
  readonly manifest: EvidenceManifest;
  readonly location: string;
  readonly report: EvidenceReport;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceRootAuditId(workspaceRoot: string, redact: Redactor): string {
  return `compaction-root-${sha256Hex(redact(workspaceRoot)).slice(0, 16)}`;
}

function redactProvenanceRef(ref: ContextProvenanceRef, redact: Redactor): ContextProvenanceRef {
  return {
    kind: ref.kind,
    stableId: redact(ref.stableId),
    ...(ref.scopePath === undefined ? {} : { scopePath: redact(ref.scopePath) }),
    ...(ref.lineRange === undefined ? {} : { lineRange: ref.lineRange }),
    ...(ref.contentHash === undefined ? {} : { contentHash: redact(ref.contentHash) }),
    ...(ref.evidenceAtomId === undefined ? {} : { evidenceAtomId: redact(ref.evidenceAtomId) }),
    ...(ref.notPersistedReason === undefined
      ? {}
      : { notPersistedReason: redact(ref.notPersistedReason) }),
  };
}

function redactPreservedFact(fact: ContextPreservedFact, redact: Redactor): ContextPreservedFact {
  return {
    statement: redact(fact.statement),
    ...(fact.sourceRef === undefined
      ? {}
      : { sourceRef: redactProvenanceRef(fact.sourceRef, redact) }),
    ...(fact.inferred === undefined ? {} : { inferred: fact.inferred }),
    ...(fact.corroborating === undefined
      ? {}
      : { corroborating: fact.corroborating.map((ref) => redactProvenanceRef(ref, redact)) }),
  };
}

function redactAssumption(assumption: ContextAssumption, redact: Redactor): ContextAssumption {
  return {
    statement: redact(assumption.statement),
    rationale: redact(assumption.rationale),
    confidence: assumption.confidence,
  };
}

function redactUserConstraint(
  constraint: ContextUserConstraint,
  redact: Redactor,
): ContextUserConstraint {
  return {
    statement: redact(constraint.statement),
    ...(constraint.sourceRef === undefined
      ? {}
      : { sourceRef: redactProvenanceRef(constraint.sourceRef, redact) }),
  };
}

function redactCommandOutcome(
  outcome: ContextCommandOutcome,
  redact: Redactor,
): ContextCommandOutcome {
  return {
    command: redact(outcome.command),
    exitCode: outcome.exitCode,
    summary: redact(outcome.summary),
  };
}

function redactInvalidationKey(
  key: ContextInvalidationKey,
  redact: Redactor,
): ContextInvalidationKey {
  return { scopePath: redact(key.scopePath), contentHash: redact(key.contentHash) };
}

function redactStrings(values: readonly string[], redact: Redactor): readonly string[] {
  return values.map((value) => redact(value));
}

function redactRehydration(
  handle: NonNullable<ContextCompactionRecord["rehydration"]>,
  redact: Redactor,
): NonNullable<ContextCompactionRecord["rehydration"]> {
  return {
    schemaVersion: handle.schemaVersion,
    laneId: handle.laneId,
    handleId: redact(handle.handleId),
    itemCount: handle.itemCount,
    approxTokens: handle.approxTokens,
    ...(handle.kind === undefined ? {} : { kind: handle.kind }),
    ...(handle.scopePath === undefined ? {} : { scopePath: redact(handle.scopePath) }),
    ...(handle.lineRange === undefined ? {} : { lineRange: handle.lineRange }),
    ...(handle.contentHash === undefined ? {} : { contentHash: redact(handle.contentHash) }),
    ...(handle.evidenceAtomId === undefined
      ? {}
      : { evidenceAtomId: redact(handle.evidenceAtomId) }),
    ...(handle.notPersistedReason === undefined
      ? {}
      : { notPersistedReason: redact(handle.notPersistedReason) }),
    ...(handle.approvedSummary === undefined
      ? {}
      : { approvedSummary: redact(handle.approvedSummary) }),
  };
}

function redactOptionalArray<T>(
  values: readonly T[] | undefined,
  map: (value: T) => T,
): readonly T[] | undefined {
  return values === undefined ? undefined : values.map(map);
}

function redactRecordBase(
  record: ContextCompactionRecord,
  redact: Redactor,
): Pick<
  ContextCompactionRecord,
  | "schemaVersion"
  | "laneId"
  | "reason"
  | "itemsBefore"
  | "itemsAfter"
  | "tokensBefore"
  | "tokensAfter"
> {
  return {
    schemaVersion: record.schemaVersion,
    laneId: record.laneId,
    reason: redact(record.reason),
    itemsBefore: record.itemsBefore,
    itemsAfter: record.itemsAfter,
    tokensBefore: record.tokensBefore,
    tokensAfter: record.tokensAfter,
  };
}

function redactScalarFields(
  record: ContextCompactionRecord,
  redact: Redactor,
): Partial<ContextCompactionRecord> {
  return {
    ...(record.summaryRefHash === undefined
      ? {}
      : { summaryRefHash: redact(record.summaryRefHash) }),
    ...(record.rehydration === undefined
      ? {}
      : { rehydration: redactRehydration(record.rehydration, redact) }),
    ...(record.orderedAt === undefined ? {} : { orderedAt: record.orderedAt }),
  };
}

function redactStructuredArrays(
  record: ContextCompactionRecord,
  redact: Redactor,
): Partial<ContextCompactionRecord> {
  const facts = redactOptionalArray(record.preservedFacts, (f) => redactPreservedFact(f, redact));
  const spans = redactOptionalArray(record.sourceSpans, (r) => redactProvenanceRef(r, redact));
  const assumptions = redactOptionalArray(record.assumptions, (a) => redactAssumption(a, redact));
  const constraints = redactOptionalArray(record.userConstraints, (c) =>
    redactUserConstraint(c, redact),
  );
  const outcomes = redactOptionalArray(record.commandOutcomes, (o) =>
    redactCommandOutcome(o, redact),
  );
  const keys = redactOptionalArray(record.invalidationKeys, (k) =>
    redactInvalidationKey(k, redact),
  );
  return {
    ...(spans === undefined ? {} : { sourceSpans: spans }),
    ...(facts === undefined ? {} : { preservedFacts: facts }),
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(constraints === undefined ? {} : { userConstraints: constraints }),
    ...(outcomes === undefined ? {} : { commandOutcomes: outcomes }),
    ...(keys === undefined ? {} : { invalidationKeys: keys }),
  };
}

function redactStringArrays(
  record: ContextCompactionRecord,
  redact: Redactor,
): Partial<ContextCompactionRecord> {
  return {
    ...(record.decisions === undefined
      ? {}
      : { decisions: redactStrings(record.decisions, redact) }),
    ...(record.openQuestions === undefined
      ? {}
      : { openQuestions: redactStrings(record.openQuestions, redact) }),
    ...(record.filesInspected === undefined
      ? {}
      : { filesInspected: redactStrings(record.filesInspected, redact) }),
    ...(record.filesChanged === undefined
      ? {}
      : { filesChanged: redactStrings(record.filesChanged, redact) }),
    ...(record.failingTests === undefined
      ? {}
      : { failingTests: redactStrings(record.failingTests, redact) }),
    ...(record.droppedCategories === undefined
      ? {}
      : { droppedCategories: redactStrings(record.droppedCategories, redact) }),
  };
}

function redactCompactionRecord(
  record: ContextCompactionRecord,
  redact: Redactor,
): ContextCompactionRecord {
  return {
    ...redactRecordBase(record, redact),
    ...redactScalarFields(record, redact),
    ...redactStructuredArrays(record, redact),
    ...redactStringArrays(record, redact),
  };
}

function buildCompactionManifest(
  input: CompactionEvidenceInput,
  redact: Redactor,
  costClassResolver?: (modelId: string) => CostClass | "unknown",
): EvidenceManifest {
  const durationMs = Math.max(0, input.finishedAt - input.startedAt);
  const compaction = input.records.map((record) => redactCompactionRecord(record, redact));
  const fingerprintSeed = input.workspaceRoot ?? input.chatIdHash ?? input.runId;
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId: input.runId,
      fingerprint: sha256Hex(redact(fingerprintSeed)),
      harnessVersion: HARNESS_VERSION,
      taskType: "connected-context",
      outcome: "completed",
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs,
    },
    model: {
      modelId: input.modelId,
      costClass: costClassResolver?.(input.modelId) ?? "unknown",
    },
    usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
    ...(input.workspaceRoot === undefined
      ? {}
      : {
          context: {
            workspaceRoot: workspaceRootAuditId(input.workspaceRoot, redact),
            totalCandidates: 0,
            usedBytes: 0,
            budgetBytes: 0,
            droppedForBudget: 0,
            entries: [],
          },
        }),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    compaction,
  };
}

export function persistCompactionEvidence(
  input: CompactionEvidenceInput,
  ctx: CompactionEvidenceContext,
): CompactionEvidencePersistResult {
  assertValidRunId(input.runId);
  const redactor = createAuditRedactor({ additionalSecrets: ctx.additionalSecrets ?? [] }, ctx.env);
  const manifest = buildCompactionManifest(input, redactor, ctx.costClassResolver);
  const safeJson = JSON.stringify(deepRedactStrings(manifest, redactor), null, 2);
  const location = ctx.store.put(manifest.run.runId, safeJson);
  applyRetention(ctx.store, ctx.retention ?? DEFAULT_RETENTION);
  return { manifest, location, report: buildEvidenceReport(manifest, location) };
}
