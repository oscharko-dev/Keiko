// Connected-context evidence persistence (Issue #187). This records what Keiko inspected and
// what metadata reached the model without persisting query text or excerpt content.

import { createHash } from "node:crypto";

import {
  HARNESS_VERSION,
  type AuditSummary,
  type ConnectedContextPack,
  type CostClass,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-security";
import { buildEvidenceReport, type EvidenceReport } from "./report.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceConnectedContextAudit,
  type EvidenceConnectedContextExcerpt,
  type EvidenceConnectedContextFile,
  type EvidenceManifest,
  type EvidenceStore,
} from "./types.js";

type Redactor = (input: string) => string;

export interface ConnectedContextEvidenceInput {
  readonly runId: string;
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly chatId?: string | undefined;
  readonly pack: ConnectedContextPack;
  readonly citationCount: number;
  readonly elapsedMs: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface ConnectedContextEvidenceContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
  readonly additionalSecrets?: readonly string[] | undefined;
  readonly costClassResolver?: ((modelId: string) => CostClass | "unknown") | undefined;
}

export interface ConnectedContextEvidencePersistResult {
  readonly manifest: EvidenceManifest;
  readonly location: string;
  readonly report: EvidenceReport;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactString(redact: Redactor, value: string): string {
  return redact(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function numberRecord(value: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") {
      out[key] = entry;
    }
  }
  return out;
}

function contextOf(input: ConnectedContextEvidenceInput, redact: Redactor): AuditSummary {
  return {
    workspaceRoot: redactString(redact, input.workspaceRoot),
    totalCandidates: input.pack.files.length + input.pack.omitted.length,
    usedBytes: input.pack.usage.excerptBytes,
    budgetBytes: input.pack.budget.excerptBytesMax,
    droppedForBudget: input.pack.omitted.filter((entry) => entry.reason === "budget-exhausted")
      .length,
    entries: [],
  };
}

function excerptOf(
  excerpt: ConnectedContextPack["files"][number]["excerpts"][number],
  redact: Redactor,
): EvidenceConnectedContextExcerpt {
  const redactedContent = redactString(redact, excerpt.content);
  return {
    atomStableId: redactString(redact, excerpt.atom.stableId),
    scopePath: redactString(redact, excerpt.atom.scopePath),
    ...(excerpt.atom.lineRange === undefined ? {} : { lineRange: excerpt.atom.lineRange }),
    score: excerpt.atom.score,
    provenanceKind: excerpt.atom.provenance.kind,
    tool: redactString(redact, excerpt.atom.provenance.tool),
    queryFingerprint: redactString(redact, excerpt.atom.provenance.queryFingerprint),
    redactionState: excerpt.atom.redactionState,
    contentBytes: excerpt.contentBytes,
    contentSha256: sha256Hex(redactedContent),
  };
}

function fileOf(
  file: ConnectedContextPack["files"][number],
  redact: Redactor,
): EvidenceConnectedContextFile {
  const excerpts = file.excerpts.map((excerpt) => excerptOf(excerpt, redact));
  return {
    scopePath: redactString(redact, file.scopePath),
    role: file.role,
    selectionReason: redactString(redact, file.selectionReason),
    excerptCount: file.excerpts.length,
    excerptBytes: file.excerpts.reduce((total, excerpt) => total + excerpt.contentBytes, 0),
    excerpts,
  };
}

function toolsUsed(pack: ConnectedContextPack, redact: Redactor): readonly string[] {
  const tools = new Set<string>(["model-gateway"]);
  for (const file of pack.files) {
    for (const excerpt of file.excerpts) {
      tools.add(redactString(redact, excerpt.atom.provenance.tool));
    }
  }
  return [...tools].sort();
}

function scopeOf(
  input: ConnectedContextEvidenceInput,
  redact: Redactor,
): EvidenceConnectedContextAudit["scope"] {
  return {
    schemaVersion: input.pack.scope.schemaVersion,
    scopeIdHash: sha256Hex(redactString(redact, input.pack.scope.scopeId)),
    scopeKind: input.pack.scope.kind,
    selectedPathCount: input.pack.scope.relativePaths.length,
    selectedPaths: input.pack.scope.relativePaths.map((path) => redactString(redact, path)),
  };
}

function queryOf(
  input: ConnectedContextEvidenceInput,
  redact: Redactor,
): EvidenceConnectedContextAudit["query"] {
  const safeQueryText = redactString(redact, input.pack.query.text);
  return {
    kind: input.pack.query.kind,
    queryTextHash: sha256Hex(safeQueryText),
    queryTextBytes: byteLength(safeQueryText),
    maxResults: input.pack.query.maxResults,
    caseSensitive: input.pack.query.caseSensitive,
  };
}

function summaryOf(input: ConnectedContextEvidenceInput): EvidenceConnectedContextAudit["summary"] {
  return {
    fileCount: input.pack.files.length,
    citationCount: input.citationCount,
    omittedCount: input.pack.omitted.length,
    uncertaintyCount: input.pack.uncertainty.length,
    elapsedMs: input.elapsedMs,
  };
}

function connectedContextOf(
  input: ConnectedContextEvidenceInput,
  redact: Redactor,
): EvidenceConnectedContextAudit {
  return {
    packSchemaVersion: input.pack.schemaVersion,
    packStableIdHash: sha256Hex(redactString(redact, input.pack.stableId)),
    chatIdHash:
      input.chatId === undefined ? undefined : sha256Hex(redactString(redact, input.chatId)),
    modelRequest: {
      sentToModel: true,
      excerptContentPersisted: false,
    },
    scope: scopeOf(input, redact),
    query: queryOf(input, redact),
    budget: {
      usage: numberRecord(input.pack.usage),
      limits: numberRecord(input.pack.budget),
    },
    files: input.pack.files.map((file) => fileOf(file, redact)),
    omitted: input.pack.omitted.map((entry) => ({
      scopePath: redactString(redact, entry.scopePath),
      reason: entry.reason,
    })),
    uncertainty: input.pack.uncertainty.map((entry) => ({
      kind: entry.kind,
      impactedAtomCount: entry.impactedAtomIds.length,
    })),
    toolsUsed: toolsUsed(input.pack, redact),
    summary: summaryOf(input),
  };
}

function buildConnectedContextEvidenceManifest(
  input: ConnectedContextEvidenceInput,
  costClassResolver?: (modelId: string) => CostClass | "unknown",
  redact: Redactor = (value) => value,
): EvidenceManifest {
  const identityDurationMs = Math.max(0, input.finishedAt - input.startedAt);
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId: input.runId,
      fingerprint: sha256Hex(redactString(redact, input.pack.stableId)),
      harnessVersion: HARNESS_VERSION,
      taskType: "connected-context",
      outcome: "completed",
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: identityDurationMs,
    },
    model: {
      modelId: input.modelId,
      costClass: costClassResolver?.(input.modelId) ?? "unknown",
    },
    usageTotals: {
      promptTokens: input.pack.usage.modelInputTokens,
      completionTokens: input.pack.usage.modelOutputTokens,
      requestCount: 1,
      totalLatencyMs: input.elapsedMs,
    },
    context: contextOf(input, redact),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    connectedContext: connectedContextOf(input, redact),
  };
}

export function persistConnectedContextEvidence(
  input: ConnectedContextEvidenceInput,
  ctx: ConnectedContextEvidenceContext,
): ConnectedContextEvidencePersistResult {
  const redactor = createAuditRedactor({ additionalSecrets: ctx.additionalSecrets ?? [] }, ctx.env);
  const manifest = buildConnectedContextEvidenceManifest(input, ctx.costClassResolver, redactor);
  const safeManifest = deepRedactStrings(manifest, redactor) as EvidenceManifest;
  const location = ctx.store.put(safeManifest.run.runId, JSON.stringify(safeManifest, null, 2));
  return { manifest: safeManifest, location, report: buildEvidenceReport(safeManifest, location) };
}
