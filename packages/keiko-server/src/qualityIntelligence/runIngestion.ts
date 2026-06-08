// Quality Intelligence run-source ingestion (Epic #270, Issue #278).
//
// Converts the inline sources of a start-run request into content-bearing evidence atoms +
// browser-safe source envelopes, reusing the pure-domain ingestion + hardening helpers from
// `@oscharko-dev/keiko-quality-intelligence`. The server tier owns IO (it is the only layer that
// may touch the filesystem); the pure domain owns splitting + hashing. Oversize and unsupported
// inputs fail with user-actionable errors (#278 AC) before any model prompt is built.

import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  QualityIntelligenceGeneration,
  QualityIntelligenceHardening,
} from "@oscharko-dev/keiko-quality-intelligence";
import type { QualityIntelligenceIngestedAtom } from "@oscharko-dev/keiko-workflows";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";

const MAX_TOTAL_ATOMS = 120;
const MAX_LABEL_CHARS = 120;

export class QiIngestionError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "QiIngestionError";
  }
}

export interface QiSourceSummary {
  readonly label: string;
  readonly kind: QualityIntelligenceInlineSource["kind"];
  readonly atomCount: number;
}

export interface QiIngestionResult {
  readonly envelopes: readonly QI.QualityIntelligenceSourceEnvelope[];
  readonly ingestedAtoms: readonly QualityIntelligenceIngestedAtom[];
  readonly provenanceRefs: {
    readonly envelopeIds: readonly string[];
    readonly auditSummaryId: QI.QualityIntelligenceAuditSummaryId;
  };
  readonly sourceSummaries: readonly QiSourceSummary[];
}

const sanitiseLabel = (label: string): string => {
  const trimmed = label.replace(/https?:\/\/\S+/giu, "").trim();
  const safe = trimmed.length === 0 ? "Untitled source" : trimmed;
  return safe.length > MAX_LABEL_CHARS ? `${safe.slice(0, MAX_LABEL_CHARS - 1)}…` : safe;
};

const envelopeIdFor = (
  index: number,
  label: string,
  content: string,
): QI.QualityIntelligenceSourceEnvelopeId => {
  const digest = sha256Hex(`qi-src-v1|${String(index)}|${label}|${content}`).slice(0, 24);
  return QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(`qi-src-${digest}`);
};

const auditSummaryIdFor = (runId: string): QI.QualityIntelligenceAuditSummaryId =>
  QualityIntelligence.asQualityIntelligenceAuditSummaryId(
    `qi-audit-${sha256Hex(runId).slice(0, 24)}`,
  );

interface OneSource {
  readonly envelope: QI.QualityIntelligenceSourceEnvelope;
  readonly atoms: readonly QualityIntelligenceIngestedAtom[];
}

function ingestRequirements(
  source: Extract<QualityIntelligenceInlineSource, { kind: "requirements" }>,
  index: number,
  registeredAt: string,
): OneSource {
  const text = typeof source.text === "string" ? source.text : "";
  const oversize = QualityIntelligenceHardening.assertSourceSize(text);
  if (!oversize.ok) {
    throw new QiIngestionError(
      "QI_SOURCE_TOO_LARGE",
      "A requirements source exceeds the size limit.",
    );
  }
  const label = sanitiseLabel(source.label);
  const envelopeId = envelopeIdFor(index, label, text);
  const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, { envelopeId });
  if (atoms.length === 0) {
    throw new QiIngestionError(
      "QI_SOURCE_EMPTY",
      `Source "${label}" produced no usable requirement statements.`,
    );
  }
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "human-context",
    displayLabel: label,
    provenance: {
      origin: "requirements",
      registeredAt,
      integrityHashSha256Hex: sha256Hex(text),
    },
    localRef: String(envelopeId),
  };
  return { envelope, atoms };
}

function ingestOne(
  source: QualityIntelligenceInlineSource,
  index: number,
  registeredAt: string,
): OneSource {
  switch (source.kind) {
    case "requirements":
      return ingestRequirements(source, index, registeredAt);
    case "workspace":
      throw new QiIngestionError(
        "QI_SOURCE_UNSUPPORTED",
        "Workspace folder ingestion is handled by the workspace ingestor.",
      );
  }
}

export interface IngestInlineSourcesInput {
  readonly request: QualityIntelligenceStartRunRequest;
  readonly runId: string;
  readonly registeredAt: string;
}

/**
 * Ingest the requirement-text sources of a start-run request. Workspace sources are ingested by
 * `ingestWorkspaceSource` (separate module owning filesystem access) and folded in by the caller.
 * Throws `QiIngestionError` with a safe, user-actionable code on empty / oversized / unsupported
 * input.
 */
export function ingestInlineSources(input: IngestInlineSourcesInput): QiIngestionResult {
  // Read through the typed property in the loop: `Array.isArray` would widen a local binding of the
  // readonly union array to `any[]`, so the guard checks length on the typed property directly.
  const sources: readonly QualityIntelligenceInlineSource[] = input.request.sources;
  if (sources.length === 0) {
    throw new QiIngestionError("QI_NO_SOURCES", "At least one source is required to start a run.");
  }
  const envelopes: QI.QualityIntelligenceSourceEnvelope[] = [];
  const ingestedAtoms: QualityIntelligenceIngestedAtom[] = [];
  const sourceSummaries: QiSourceSummary[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (source === undefined) continue;
    const { envelope, atoms } = ingestOne(source, i, input.registeredAt);
    const remaining = MAX_TOTAL_ATOMS - ingestedAtoms.length;
    const taken = remaining <= 0 ? [] : atoms.slice(0, remaining);
    envelopes.push(envelope);
    ingestedAtoms.push(...taken);
    sourceSummaries.push({
      label: envelope.displayLabel,
      kind: source.kind,
      atomCount: taken.length,
    });
  }
  if (ingestedAtoms.length === 0) {
    throw new QiIngestionError(
      "QI_SOURCE_EMPTY",
      "No usable evidence was produced from the sources.",
    );
  }
  return {
    envelopes,
    ingestedAtoms,
    provenanceRefs: {
      envelopeIds: envelopes.map((e) => String(e.id)),
      auditSummaryId: auditSummaryIdFor(input.runId),
    },
    sourceSummaries,
  };
}
