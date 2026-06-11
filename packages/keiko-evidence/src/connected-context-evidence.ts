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
import { applyRetention } from "./retention.js";
import {
  DEFAULT_RETENTION,
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceConnectedContextAudit,
  type EvidenceConnectedContextExcerpt,
  type EvidenceConnectedContextFile,
  type EvidenceManifest,
  type EvidenceStore,
  type RetentionPolicy,
} from "./types.js";

type Redactor = (input: string) => string;

export interface ConnectedContextEvidenceInput {
  readonly runId: string;
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly chatId?: string | undefined;
  readonly plan?: ConnectedContextEvidencePlanInput | undefined;
  readonly pack: ConnectedContextPack;
  readonly citationCount: number;
  readonly elapsedMs: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface ConnectedContextEvidencePlanInput {
  readonly planId: string;
  readonly state: string;
  readonly createdAtMs?: number | undefined;
  readonly anchors?: readonly ConnectedContextEvidencePlanAnchorInput[] | undefined;
  readonly rings?: readonly ConnectedContextEvidencePlanRingInput[] | undefined;
  readonly clarification?:
    | {
        readonly reason?: string | undefined;
      }
    | undefined;
}

export interface ConnectedContextEvidencePlanAnchorInput {
  readonly term: string;
  readonly kind: string;
}

export interface ConnectedContextEvidencePlanRingInput {
  readonly kind: string;
}

export interface ConnectedContextEvidenceContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
  readonly additionalSecrets?: readonly string[] | undefined;
  readonly costClassResolver?: ((modelId: string) => CostClass | "unknown") | undefined;
  readonly retention?: RetentionPolicy | undefined;
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

function workspaceRootAuditId(workspaceRoot: string, redact: Redactor): string {
  return `connected-context-root-${sha256Hex(redactString(redact, workspaceRoot)).slice(0, 16)}`;
}

function contextOf(input: ConnectedContextEvidenceInput, redact: Redactor): AuditSummary {
  return {
    workspaceRoot: workspaceRootAuditId(input.workspaceRoot, redact),
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

function planOf(
  input: ConnectedContextEvidenceInput,
  redact: Redactor,
): EvidenceConnectedContextAudit["plan"] {
  if (input.plan === undefined || typeof input.plan.planId !== "string") {
    return undefined;
  }
  const anchors = input.plan.anchors ?? [];
  const rings = input.plan.rings ?? [];
  const anchorKinds: Record<string, number> = {};
  const anchorTermHashes = anchors
    .map((anchor) => {
      anchorKinds[anchor.kind] = (anchorKinds[anchor.kind] ?? 0) + 1;
      return sha256Hex(redactString(redact, anchor.term));
    })
    .sort();
  return {
    planIdHash: sha256Hex(redactString(redact, input.plan.planId)),
    state: input.plan.state,
    createdAtMs:
      typeof input.plan.createdAtMs === "number" ? Math.max(0, input.plan.createdAtMs) : undefined,
    anchorCount: anchorTermHashes.length,
    anchorKinds,
    anchorTermHashes,
    ringKinds: rings.map((ring) => ring.kind).sort(),
    clarificationReason:
      typeof input.plan.clarification?.reason === "string"
        ? input.plan.clarification.reason
        : undefined,
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
    plan: planOf(input, redact),
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
  applyRetention(ctx.store, ctx.retention ?? DEFAULT_RETENTION);
  return { manifest: safeManifest, location, report: buildEvidenceReport(safeManifest, location) };
}
