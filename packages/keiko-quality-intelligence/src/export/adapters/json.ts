// Typed JSON export adapter (Epic #270, Issue #283).
//
// Produces a deterministic JSON document with stable key ordering and stable
// candidate ordering. Object keys appear in the order written (V8 insertion
// order preservation); candidate / entry arrays are sorted by id to keep
// byte-for-byte determinism across runs.
//
// Pure-domain leaf. Reuses `assertExportBundleInvariant`. JSON is a portable
// target so the redactionAttested invariant fires only when the bundle's
// adapter is TMS-bound — pure `json` adapter does not require attestation by
// design (matches the contract-side TMS adapter set).

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceExportBundleEntry,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";

interface JsonExportCandidatePayload {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly priority: string;
  readonly riskClass: string;
  readonly status: string;
  readonly tags: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
  readonly derivedFromAtomIds: readonly string[];
  readonly coverageMapRefs: readonly string[];
  readonly findingRefs: readonly string[];
}

interface JsonExportEnvelope {
  readonly schemaVersion: "1";
  readonly bundleId: string;
  readonly runId: string;
  readonly targetAdapter: string;
  readonly createdAt: string;
  readonly integrityHashSha256Hex: string;
  readonly redactionAttested: boolean;
  readonly candidates: readonly JsonExportCandidatePayload[];
}

const byCandidateIdAsc = (
  a: QualityIntelligenceExportBundleEntry,
  b: QualityIntelligenceExportBundleEntry,
): number => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0);

export function adaptToJson(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const sortedEntries = [...bundle.contents].sort(byCandidateIdAsc);
  const payloadCandidates: JsonExportCandidatePayload[] = [];
  for (const entry of sortedEntries) {
    const candidate = byId.get(entry.candidateId);
    if (candidate === undefined) {
      continue;
    }
    payloadCandidates.push({
      id: candidate.id,
      runId: candidate.runId,
      title: candidate.title,
      priority: candidate.priority,
      riskClass: candidate.riskClass,
      status: candidate.status,
      tags: candidate.tags,
      preconditions: candidate.preconditions,
      steps: candidate.steps,
      expectedResults: candidate.expectedResults,
      derivedFromAtomIds: candidate.derivedFromAtomIds,
      coverageMapRefs: entry.coverageMapRefs,
      findingRefs: entry.findingRefs,
    });
  }
  const envelope: JsonExportEnvelope = {
    schemaVersion: "1",
    bundleId: bundle.id,
    runId: bundle.runId,
    targetAdapter: bundle.targetAdapter,
    createdAt: bundle.createdAt,
    integrityHashSha256Hex: bundle.integrityHashSha256Hex,
    redactionAttested: bundle.redactionAttested,
    candidates: payloadCandidates,
  };
  return JSON.stringify(envelope, null, 2);
}
