// Quality Intelligence inline-edit revision contracts (Epic #712, Issue #725).
//
// A reviewer may edit a generated test-case body inline on the run card. An edit UPDATES the
// candidate row in place inside the mutable `candidates[]` artifact AND appends a provenance
// entry to a new `editedRevisions[]` array. Export/BFF read `candidates[]` unchanged and so
// automatically reflect edited text; provenance/audit lives in `editedRevisions[]`. The
// immutable run manifest (`<runId>.qi.json`) is never touched.

import type {
  QualityIntelligencePriority,
  QualityIntelligenceRiskClass,
} from "./testCaseCandidate.js";

export interface QualityIntelligenceCandidateEditProvenance {
  readonly editedAt: string;
  readonly editedBy: "human" | "api";
  readonly editorLabel: string;
}

// All optional: an edit submits only the fields the reviewer changed. The persist helper merges
// the supplied (redacted) fields over the existing row, leaving untouched fields intact.
export interface QualityIntelligenceCandidateEditableFields {
  readonly title?: string;
  readonly preconditions?: readonly string[];
  readonly steps?: readonly string[];
  readonly expectedResults?: readonly string[];
  readonly priority?: QualityIntelligencePriority;
  readonly riskClass?: QualityIntelligenceRiskClass;
  readonly tags?: readonly string[];
}

export interface QualityIntelligenceCandidateEditedRevision {
  readonly candidateId: string;
  readonly provenance: QualityIntelligenceCandidateEditProvenance;
  readonly editedFields: QualityIntelligenceCandidateEditableFields;
}
