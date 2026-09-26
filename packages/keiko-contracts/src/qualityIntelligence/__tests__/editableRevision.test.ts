// Tests for the QI inline-edit revision contracts (Epic #712, Issue #725).
//
// KEIKO-0593: QualityIntelligenceCandidateEditedRevision.candidateId was a bare `string` even
// though the file it links to (testCaseCandidate.ts) has always branded its own `id` as
// QualityIntelligenceTestCaseId — the one link in the edit-provenance chain that carried no
// validation. This is the first test file for editableRevision.ts.

import { describe, expect, it } from "vitest";
import { asQualityIntelligenceTestCaseId } from "../ids.js";
import type {
  QualityIntelligenceCandidateEditProvenance,
  QualityIntelligenceCandidateEditedRevision,
} from "../editableRevision.js";

const PROVENANCE: QualityIntelligenceCandidateEditProvenance = {
  editedAt: "2026-08-25T00:00:00.000Z",
  editedBy: "human",
  editorLabel: "Reviewer A",
};

describe("QualityIntelligenceCandidateEditedRevision.candidateId (KEIKO-0593)", () => {
  it("accepts a branded QualityIntelligenceTestCaseId built by the real constructor", () => {
    const revision: QualityIntelligenceCandidateEditedRevision = {
      candidateId: asQualityIntelligenceTestCaseId("tc-001"),
      provenance: PROVENANCE,
      editedFields: { title: "Login test (edited)" },
    };
    expect(revision.candidateId).toBe("tc-001");
  });

  it("rejects a hostile candidateId at the branding boundary (path-traversal fragment)", () => {
    // Proves the audit link now carries the same validation every other persisted QI id does:
    // before KEIKO-0593, `candidateId: string` accepted this value with no rejection at all.
    expect(() => asQualityIntelligenceTestCaseId("../etc/passwd")).toThrow(TypeError);
  });

  it("round-trips through JSON.stringify / parse (brand carrier never lands at runtime)", () => {
    const revision: QualityIntelligenceCandidateEditedRevision = {
      candidateId: asQualityIntelligenceTestCaseId("tc-002"),
      provenance: PROVENANCE,
      editedFields: { preconditions: [], tags: [] },
    };
    const round = JSON.parse(
      JSON.stringify(revision),
    ) as QualityIntelligenceCandidateEditedRevision;
    expect(round).toEqual(revision);
  });
});
