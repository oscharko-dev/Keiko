// Fixture loader used ONLY by tests in this directory.
//
// Loads the synthetic golden fixtures and reshapes the JSON into the strict
// QualityIntelligence contract types. The loader uses `node:fs` and
// `node:path`; this is acceptable because the file lives under
// __tests__/ (excluded from the production purity guard) and is itself a
// test-support module — not exported from the package barrel.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface RawProvenance {
  readonly origin: string;
  readonly registeredAt: string;
  readonly integrityHashSha256Hex: string;
}

interface RawEnvelope {
  readonly kind: QualityIntelligence.QualityIntelligenceSourceKind;
  readonly id: string;
  readonly displayLabel: string;
  readonly localRef: string;
  readonly adapterId?: string;
  readonly provenance: RawProvenance;
}

interface RawAtom {
  readonly kind: QualityIntelligence.QualityIntelligenceEvidenceAtomKind;
  readonly id: string;
  readonly sourceEnvelopeId: string;
  readonly canonicalHashSha256Hex: string;
  readonly redactionStatus: QualityIntelligence.QualityIntelligenceRedactionStatus;
  readonly lifecycleStatus: QualityIntelligence.QualityIntelligenceLifecycleStatus;
}

interface RawFixture {
  readonly _header: string;
  readonly runId: string;
  readonly envelopes: readonly RawEnvelope[];
  readonly atoms: readonly RawAtom[];
}

export interface LoadedFixture {
  readonly header: string;
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly envelopes: readonly QualityIntelligence.QualityIntelligenceSourceEnvelope[];
  readonly atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[];
}

const reshapeEnvelope = (
  raw: RawEnvelope,
): QualityIntelligence.QualityIntelligenceSourceEnvelope => {
  const id = QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(raw.id);
  const common = {
    id,
    displayLabel: raw.displayLabel,
    provenance: raw.provenance,
  };
  switch (raw.kind) {
    case "repository-context":
      return { ...common, kind: "repository-context", localRef: raw.localRef };
    case "local-knowledge-capsule":
      return { ...common, kind: "local-knowledge-capsule", localRef: raw.localRef };
    case "figma-evidence":
      return { ...common, kind: "figma-evidence", localRef: raw.localRef };
    case "human-context":
      return { ...common, kind: "human-context", localRef: raw.localRef };
    case "connector-document":
      return {
        ...common,
        kind: "connector-document",
        localRef: raw.localRef,
        adapterId: raw.adapterId ?? "synthetic-adapter",
      };
    default:
      return QualityIntelligence.assertQualityIntelligenceNever(raw.kind);
  }
};

const reshapeAtom = (raw: RawAtom): QualityIntelligence.QualityIntelligenceEvidenceAtom => {
  const id = QualityIntelligence.asQualityIntelligenceEvidenceAtomId(raw.id);
  const sourceEnvelopeId = QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(
    raw.sourceEnvelopeId,
  );
  const common = {
    id,
    sourceEnvelopeId,
    canonicalHashSha256Hex: raw.canonicalHashSha256Hex,
    redactionStatus: raw.redactionStatus,
    lifecycleStatus: raw.lifecycleStatus,
  };
  switch (raw.kind) {
    case "requirement":
      return { ...common, kind: "requirement" };
    case "design-fragment":
      return { ...common, kind: "design-fragment" };
    case "code-fragment":
      return { ...common, kind: "code-fragment" };
    case "document-excerpt":
      return { ...common, kind: "document-excerpt" };
    case "human-statement":
      return { ...common, kind: "human-statement" };
    default:
      return QualityIntelligence.assertQualityIntelligenceNever(raw.kind);
  }
};

export const loadFixture = (relativePath: string): LoadedFixture => {
  const absolute = resolve(HERE, "fixtures", relativePath);
  const text = readFileSync(absolute, "utf8");
  const raw = JSON.parse(text) as RawFixture;
  return {
    header: raw._header,
    runId: QualityIntelligence.asQualityIntelligenceRunId(raw.runId),
    envelopes: raw.envelopes.map(reshapeEnvelope),
    atoms: raw.atoms.map(reshapeAtom),
  };
};
