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
  redactAbsolutePaths,
  type ContextCommandOutcome,
  type ContextCompactionModelSummary,
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

function redactedPathSafe(value: string, redact: Redactor): string {
  return redactAbsolutePaths(redact(value));
}

function redactProvenanceRef(ref: ContextProvenanceRef, redact: Redactor): ContextProvenanceRef {
  return {
    kind: ref.kind,
    stableId: redactedPathSafe(ref.stableId, redact),
    ...(ref.scopePath === undefined ? {} : { scopePath: redactedPathSafe(ref.scopePath, redact) }),
    ...(ref.lineRange === undefined ? {} : { lineRange: ref.lineRange }),
    ...(ref.contentHash === undefined
      ? {}
      : { contentHash: redactedPathSafe(ref.contentHash, redact) }),
    ...(ref.evidenceAtomId === undefined
      ? {}
      : { evidenceAtomId: redactedPathSafe(ref.evidenceAtomId, redact) }),
    ...(ref.notPersistedReason === undefined
      ? {}
      : { notPersistedReason: redactedPathSafe(ref.notPersistedReason, redact) }),
  };
}

function redactPreservedFact(fact: ContextPreservedFact, redact: Redactor): ContextPreservedFact {
  return {
    statement: redactedPathSafe(fact.statement, redact),
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
    statement: redactedPathSafe(assumption.statement, redact),
    rationale: redactedPathSafe(assumption.rationale, redact),
    confidence: assumption.confidence,
  };
}

function redactUserConstraint(
  constraint: ContextUserConstraint,
  redact: Redactor,
): ContextUserConstraint {
  return {
    statement: redactedPathSafe(constraint.statement, redact),
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
    command: redactedPathSafe(outcome.command, redact),
    exitCode: outcome.exitCode,
    summary: redactedPathSafe(outcome.summary, redact),
  };
}

function redactInvalidationKey(
  key: ContextInvalidationKey,
  redact: Redactor,
): ContextInvalidationKey {
  return {
    scopePath: redactedPathSafe(key.scopePath, redact),
    contentHash: redactedPathSafe(key.contentHash, redact),
  };
}

function redactModelSummary(
  summary: ContextCompactionModelSummary,
  redact: Redactor,
): ContextCompactionModelSummary {
  return {
    promptVersion: summary.promptVersion,
    modelId: redactedPathSafe(summary.modelId, redact),
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(summary.validationState === undefined ? {} : { validationState: summary.validationState }),
    ...(summary.failureReason === undefined ? {} : { failureReason: summary.failureReason }),
    content: redactedPathSafe(summary.content, redact),
    ...(summary.decisions === undefined
      ? {}
      : { decisions: redactStrings(summary.decisions, redact) }),
    ...(summary.constraints === undefined
      ? {}
      : { constraints: redactStrings(summary.constraints, redact) }),
    ...(summary.filesAndSymbols === undefined
      ? {}
      : { filesAndSymbols: redactStrings(summary.filesAndSymbols, redact) }),
    ...(summary.debuggingContext === undefined
      ? {}
      : { debuggingContext: redactStrings(summary.debuggingContext, redact) }),
    ...(summary.openThreads === undefined
      ? {}
      : { openThreads: redactStrings(summary.openThreads, redact) }),
  };
}

function redactStrings(values: readonly string[], redact: Redactor): readonly string[] {
  return values.map((value) => redactedPathSafe(value, redact));
}

function redactRehydration(
  handle: NonNullable<ContextCompactionRecord["rehydration"]>,
  redact: Redactor,
): NonNullable<ContextCompactionRecord["rehydration"]> {
  return {
    schemaVersion: handle.schemaVersion,
    laneId: handle.laneId,
    handleId: redactedPathSafe(handle.handleId, redact),
    itemCount: handle.itemCount,
    approxTokens: handle.approxTokens,
    ...(handle.kind === undefined ? {} : { kind: handle.kind }),
    ...(handle.scopePath === undefined
      ? {}
      : { scopePath: redactedPathSafe(handle.scopePath, redact) }),
    ...(handle.lineRange === undefined ? {} : { lineRange: handle.lineRange }),
    ...(handle.contentHash === undefined
      ? {}
      : { contentHash: redactedPathSafe(handle.contentHash, redact) }),
    ...(handle.evidenceAtomId === undefined
      ? {}
      : { evidenceAtomId: redactedPathSafe(handle.evidenceAtomId, redact) }),
    ...(handle.notPersistedReason === undefined
      ? {}
      : { notPersistedReason: redactedPathSafe(handle.notPersistedReason, redact) }),
    ...(handle.approvedSummary === undefined
      ? {}
      : { approvedSummary: redactedPathSafe(handle.approvedSummary, redact) }),
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
    reason: redactedPathSafe(record.reason, redact),
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
      : { summaryRefHash: redactedPathSafe(record.summaryRefHash, redact) }),
    ...(record.rehydration === undefined
      ? {}
      : { rehydration: redactRehydration(record.rehydration, redact) }),
    ...(record.orderedAt === undefined ? {} : { orderedAt: record.orderedAt }),
    ...(record.modelSummary === undefined
      ? {}
      : { modelSummary: redactModelSummary(record.modelSummary, redact) }),
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
