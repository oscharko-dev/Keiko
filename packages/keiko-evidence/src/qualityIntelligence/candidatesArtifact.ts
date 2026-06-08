// Quality Intelligence generated-candidate artifact (Issue #274/#280, Epic #270, ADR-0023 D8).
//
// The run manifest (`<runId>.qi.json`) carries only counts + refs. The reviewable, exportable
// product — the generated test-case bodies — is persisted here as a companion artifact
// `<runId>.candidates.json`. Bodies are redacted (every string leaf) BEFORE persist so a candidate
// that echoed a secret-shaped source string cannot reach disk, preview, or export unredacted
// (Issue #284). Stored as plain rows (branded IDs collapse to strings on the wire).

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  createNodeContainedJsonArtifactStore,
  type ContainedJsonArtifactStore,
} from "./companionStore.js";

export const QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION = 1 as const;

const CANDIDATES_SUFFIX = ".candidates.json";

export interface QualityIntelligenceCandidateRow {
  readonly id: string;
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
  readonly priority: QualityIntelligence.QualityIntelligencePriority;
  readonly riskClass: QualityIntelligence.QualityIntelligenceRiskClass;
  readonly tags: readonly string[];
  readonly status: QualityIntelligence.QualityIntelligenceTestCaseStatus;
  readonly derivedFromAtomIds: readonly string[];
}

export interface QualityIntelligenceCandidatesArtifact {
  readonly qiCandidatesSchemaVersion: typeof QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION;
  readonly runId: string;
  readonly generatedAt: string;
  readonly candidates: readonly QualityIntelligenceCandidateRow[];
}

const toRow = (
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): QualityIntelligenceCandidateRow => ({
  id: String(candidate.id),
  title: candidate.title,
  preconditions: [...candidate.preconditions],
  steps: [...candidate.steps],
  expectedResults: [...candidate.expectedResults],
  priority: candidate.priority,
  riskClass: candidate.riskClass,
  tags: [...candidate.tags],
  status: candidate.status,
  derivedFromAtomIds: candidate.derivedFromAtomIds.map(String),
});

// Strict-schema gate on read: reject any artifact whose version literal drifts so a stale or
// tampered file fails closed instead of surfacing a wrong shape to the BFF.
const parseArtifact = (value: unknown): QualityIntelligenceCandidatesArtifact | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.qiCandidatesSchemaVersion !== QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION) {
    return undefined;
  }
  if (typeof record.runId !== "string" || !Array.isArray(record.candidates)) return undefined;
  return value as QualityIntelligenceCandidatesArtifact;
};

export interface QualityIntelligenceCandidatesStoreOptions {
  readonly evidenceDir: string;
}

const storeFor = (
  evidenceDir: string,
): ContainedJsonArtifactStore<QualityIntelligenceCandidatesArtifact> =>
  createNodeContainedJsonArtifactStore(evidenceDir, CANDIDATES_SUFFIX, { parse: parseArtifact });

export interface RecordQualityIntelligenceCandidatesInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[];
  readonly evidenceDir: string;
  /**
   * Required defence-in-depth redactor applied to every string leaf before persist. The server
   * passes the live audit redactor (`deps.redactor`); tests pass an explicit identity. Making it
   * mandatory keeps a forgetful caller from writing an unredacted candidate body to disk (#284).
   */
  readonly redact: (value: unknown) => unknown;
}

/**
 * Persist the generated candidate bodies for a run. Redacts every string leaf first, then writes
 * the companion artifact atomically. Returns the on-disk location.
 */
export const recordQualityIntelligenceCandidates = (
  input: RecordQualityIntelligenceCandidatesInput,
): string => {
  const rows = input.candidates.map(toRow);
  const redactedRows = input.redact(rows) as readonly QualityIntelligenceCandidateRow[];
  const artifact: QualityIntelligenceCandidatesArtifact = {
    qiCandidatesSchemaVersion: QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION,
    runId: input.runId,
    generatedAt: input.generatedAt,
    candidates: redactedRows,
  };
  return storeFor(input.evidenceDir).record(input.runId, artifact);
};

export const loadQualityIntelligenceCandidates = (
  runId: string,
  options: QualityIntelligenceCandidatesStoreOptions,
): QualityIntelligenceCandidatesArtifact | undefined => storeFor(options.evidenceDir).load(runId);

export const deleteQualityIntelligenceCandidates = (
  runId: string,
  options: QualityIntelligenceCandidatesStoreOptions,
): boolean => storeFor(options.evidenceDir).delete(runId);
