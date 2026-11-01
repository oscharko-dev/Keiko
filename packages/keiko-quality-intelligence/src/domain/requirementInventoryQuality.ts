// Requirement-quality findings for an inventory (#4179, Epic #4173).
//
// The existing deterministic requirement-quality checks run over every inventory entry; the one
// finding the inventory itself can state, a requirement without acceptance criteria, is added with
// its own closed code. Findings are closed codes (no free text), so they can travel into a backlog
// draft without carrying document content.

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import * as QualityIntelligence from "@oscharko-dev/keiko-contracts/runtime/qualityIntelligence/index";

import {
  REQUIREMENT_DIGEST_SHORT_LENGTH,
  type RequirementInventoryEntry,
} from "./requirementInventory.js";
import { analyzeRequirementQuality } from "./requirementQuality.js";

export const MISSING_ACCEPTANCE_CRITERIA = "missing-acceptance-criteria" as const;
export type RequirementInventoryFinding =
  | QualityIntelligence.QualityIntelligenceRequirementQualityCategory
  | typeof MISSING_ACCEPTANCE_CRITERIA;

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-requirement-inventory");
const ENVELOPE_ID = QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(
  "qi-env-requirement-inventory",
);

function atomFor(
  entry: RequirementInventoryEntry,
): QualityIntelligence.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(
      `qi-atom-inv-${entry.digest.slice(0, REQUIREMENT_DIGEST_SHORT_LENGTH * 2)}`,
    ),
    kind: "requirement",
    sourceEnvelopeId: ENVELOPE_ID,
    canonicalHashSha256Hex: entry.digest,
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

function canonicalText(entry: RequirementInventoryEntry): string {
  return [entry.title, entry.statement].filter((part) => part.length > 0).join(". ");
}

function categoriesByAtom(
  entries: readonly RequirementInventoryEntry[],
): ReadonlyMap<string, ReadonlySet<RequirementInventoryFinding>> {
  const atoms = entries.map((entry) => ({
    atom: atomFor(entry),
    canonicalText: canonicalText(entry),
  }));
  const byAtom = new Map<string, Set<RequirementInventoryFinding>>();
  for (const finding of analyzeRequirementQuality({ runId: RUN_ID, atoms })) {
    for (const atomId of finding.evidenceAtomIds) {
      const set = byAtom.get(String(atomId)) ?? new Set<RequirementInventoryFinding>();
      byAtom.set(String(atomId), set.add(finding.category));
    }
  }
  return byAtom;
}

/** Closed finding codes per entry id, in a stable order; an entry without findings is absent. */
export function assessRequirementInventoryQuality(
  entries: readonly RequirementInventoryEntry[],
): ReadonlyMap<string, readonly RequirementInventoryFinding[]> {
  const byAtom = categoriesByAtom(entries);
  const result = new Map<string, readonly RequirementInventoryFinding[]>();
  for (const entry of entries) {
    const found = new Set(byAtom.get(String(atomFor(entry).id)) ?? []);
    if (entry.acceptanceCriteria.length === 0) found.add(MISSING_ACCEPTANCE_CRITERIA);
    if (found.size > 0) result.set(entry.id, [...found].sort(compareStrings));
  }
  return result;
}
