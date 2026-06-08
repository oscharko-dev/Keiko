// Inline-edit helper tests for the QI candidate companion artifact (Epic #712, Issue #725).
//
// Seeds a real evidenceDir with a recorded candidate artifact, then exercises
// `applyQualityIntelligenceCandidateEdit`: edit persists + survives reload; the mandatory redactor
// is applied to edited fields BEFORE persist; candidate-not-found / artifact-not-found / empty-fields
// are rejected with typed reasons; multiple edits accumulate revisions; the row reflects the latest
// edit. No mocks — pure function + real fs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  applyQualityIntelligenceCandidateEdit,
  loadQualityIntelligenceCandidates,
  recordQualityIntelligenceCandidates,
} from "../candidatesArtifact.js";

type Candidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;
type EditProvenance = QualityIntelligence.QualityIntelligenceCandidateEditProvenance;

const RUN_ID = "run-edit-001";

const identityRedact = (value: unknown): unknown => value;

// A tagging redactor that uppercases every string leaf — proves the helper redacts edited fields
// before persist (the real server passes the live audit redactor).
const upcaseRedact = (value: unknown): unknown => {
  if (typeof value === "string") return value.toUpperCase();
  if (Array.isArray(value)) return value.map(upcaseRedact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, upcaseRedact(v)]),
    );
  }
  return value;
};

function seedCandidate(id: string): Candidate {
  return {
    id: id as Candidate["id"],
    runId: RUN_ID as Candidate["runId"],
    derivedFromAtomIds: [],
    title: `Original ${id}`,
    preconditions: ["pre-a"],
    steps: ["step-a"],
    expectedResults: ["result-a"],
    priority: "P2",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

function provenance(): EditProvenance {
  return { editedAt: "2026-06-08T12:00:00.000Z", editedBy: "human", editorLabel: "Alice" };
}

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-cand-edit-"));
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-06-08T10:00:00.000Z",
    candidates: [seedCandidate("tc-1"), seedCandidate("tc-2")],
    evidenceDir,
    redact: identityRedact,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("applyQualityIntelligenceCandidateEdit — persistence", () => {
  it("returns ok with the updated candidate row reflecting the edit", () => {
    const result = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Edited title", priority: "P0" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.candidate.title).toBe("Edited title");
    expect(result.candidate.priority).toBe("P0");
  });

  it("persists the edit so it survives a reload", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Edited title", steps: ["new-step-1", "new-step-2"] },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    const row = reloaded?.candidates.find((c) => c.id === "tc-1");
    expect(row?.title).toBe("Edited title");
    expect(row?.steps).toEqual(["new-step-1", "new-step-2"]);
  });

  it("leaves untouched fields and sibling candidates unchanged", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Only title changed" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    const tc1 = reloaded?.candidates.find((c) => c.id === "tc-1");
    const tc2 = reloaded?.candidates.find((c) => c.id === "tc-2");
    expect(tc1?.steps).toEqual(["step-a"]);
    expect(tc2?.title).toBe("Original tc-2");
  });
});

describe("applyQualityIntelligenceCandidateEdit — redaction", () => {
  it("applies the mandatory redactor to edited fields before persist", () => {
    const result = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "secret-token", tags: ["leak"] },
      provenance: provenance(),
      evidenceDir,
      redact: upcaseRedact,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.candidate.title).toBe("SECRET-TOKEN");
    expect(result.candidate.tags).toEqual(["LEAK"]);
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    const row = reloaded?.candidates.find((c) => c.id === "tc-1");
    expect(row?.title).toBe("SECRET-TOKEN");
  });

  it("stores the redacted (not raw) text in the appended revision provenance", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "raw-value" },
      provenance: provenance(),
      evidenceDir,
      redact: upcaseRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions?.[0]?.editedFields.title).toBe("RAW-VALUE");
  });
});

describe("applyQualityIntelligenceCandidateEdit — revisions accumulate", () => {
  it("appends one revision entry per edit with provenance", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "First" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Second" },
      provenance: { ...provenance(), editorLabel: "Bob" },
      evidenceDir,
      redact: identityRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions).toHaveLength(2);
    expect(reloaded?.editedRevisions?.[0]?.provenance.editorLabel).toBe("Alice");
    expect(reloaded?.editedRevisions?.[1]?.provenance.editorLabel).toBe("Bob");
  });

  it("reflects the latest edit on the row after multiple edits", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "First" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Latest" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.candidates.find((c) => c.id === "tc-1")?.title).toBe("Latest");
  });
});

describe("applyQualityIntelligenceCandidateEdit — rejections", () => {
  it("rejects when no editable field is supplied", () => {
    const result = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: {},
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.reason).toBe("no-edited-fields");
  });

  it("rejects when the candidate id is not present", () => {
    const result = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-missing",
      editedFields: { title: "x" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.reason).toBe("candidate-not-found");
  });

  it("rejects when the artifact does not exist for the run", () => {
    const result = applyQualityIntelligenceCandidateEdit({
      runId: "run-does-not-exist",
      candidateId: "tc-1",
      editedFields: { title: "x" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.reason).toBe("artifact-not-found");
  });

  it("does not append a revision when an edit is rejected", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-missing",
      editedFields: { title: "x" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions ?? []).toHaveLength(0);
  });
});
