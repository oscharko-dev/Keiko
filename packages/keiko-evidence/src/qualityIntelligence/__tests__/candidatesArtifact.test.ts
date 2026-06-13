// Inline-edit helper tests for the QI candidate companion artifact (Epic #712, Issue #725).
//
// Seeds a real evidenceDir with a recorded candidate artifact, then exercises
// `applyQualityIntelligenceCandidateEdit`: edit persists + survives reload; the mandatory redactor
// is applied to edited fields BEFORE persist; candidate-not-found / artifact-not-found / empty-fields
// are rejected with typed reasons; multiple edits accumulate revisions; the row reflects the latest
// edit. No mocks — pure function + real fs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  applyQualityIntelligenceCandidateEdit,
  loadQualityIntelligenceCandidates,
  recordQualityIntelligenceCandidates,
} from "../candidatesArtifact.js";
import { QI_SUBDIR } from "../store.js";
import { EvidenceReadError } from "../../errors.js";

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

// A targeted redactor that scrubs only the secret token `SECRET` from every string leaf, modelling
// the real audit redactor (which scrubs secret-shaped substrings and leaves enums / ISO dates / plain
// labels intact). Used to assert provenance redaction without corrupting the `editedBy` enum or
// `editedAt` timestamp the way an uppercase-everything double would.
const tokenRedact = (value: unknown): unknown => {
  if (typeof value === "string") return value.split("SECRET").join("[REDACTED]");
  if (Array.isArray(value)) return value.map(tokenRedact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, tokenRedact(v)]),
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

function artifactPath(dir: string): string {
  return join(dir, QI_SUBDIR, `${RUN_ID}.candidates.json`);
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

  it("stores the redacted (not raw) edited fields in the appended revision", () => {
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

  it("redacts the appended revision provenance label before persist", () => {
    // editorLabel is user-controlled free text from the wire (editRoutes parseEditorLabel) and is
    // persisted into the candidates artifact alongside the edited body. It must pass through the
    // mandatory redactor BEFORE reaching disk — parity with recordQualityIntelligenceCandidates,
    // which redacts the whole editedRevisions[] (provenance included). Without that, a secret-shaped
    // label reaches `<runId>.candidates.json` unredacted (redaction-before-persist bypass).
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "raw-value" },
      provenance: {
        editedAt: "2026-06-08T12:00:00.000Z",
        editedBy: "human",
        editorLabel: "SECRET",
      },
      evidenceDir,
      redact: tokenRedact,
    });
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    const rev = reloaded?.editedRevisions?.[0];
    expect(rev?.provenance.editorLabel).toBe("[REDACTED]");
    // The enum + timestamp carry no secret shape and must survive redaction unchanged, so the
    // strict read validator (isEditedRevision) still accepts the reloaded artifact.
    expect(rev?.provenance.editedBy).toBe("human");
    expect(rev?.provenance.editedAt).toBe("2026-06-08T12:00:00.000Z");
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

describe("applyQualityIntelligenceCandidateEdit — no-op deduplication", () => {
  it("does not append a duplicate revision when identical content is submitted twice", () => {
    const first = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Edited title" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");
    expect(first.changed).toBe(true);

    const second = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "Edited title" },
      provenance: provenance(),
      evidenceDir,
      redact: identityRedact,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");
    expect(second.changed).toBe(false);

    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions).toHaveLength(1);
  });

  it("treats a redacted-to-the-same-value edit as a no-op", () => {
    applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "secret-token" },
      provenance: provenance(),
      evidenceDir,
      redact: upcaseRedact,
    });

    const repeated = applyQualityIntelligenceCandidateEdit({
      runId: RUN_ID,
      candidateId: "tc-1",
      editedFields: { title: "secret-token" },
      provenance: { ...provenance(), editorLabel: "Bob" },
      evidenceDir,
      redact: upcaseRedact,
    });
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) throw new Error("expected ok");
    expect(repeated.changed).toBe(false);

    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.candidates.find((c) => c.id === "tc-1")?.title).toBe("SECRET-TOKEN");
    expect(reloaded?.editedRevisions).toHaveLength(1);
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

describe("loadQualityIntelligenceCandidates — fail closed companion parsing", () => {
  it("throws EvidenceReadError for a malformed nested candidate row", () => {
    const current = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    if (current === undefined) throw new Error("expected seeded artifact");
    writeFileSync(
      artifactPath(evidenceDir),
      JSON.stringify({
        ...current,
        candidates: current.candidates.map((candidate) =>
          candidate.id === "tc-1" ? { ...candidate, steps: "not-an-array" } : candidate,
        ),
      }),
      "utf8",
    );

    expect(() => loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("throws EvidenceReadError for malformed edited revisions", () => {
    const current = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    if (current === undefined) throw new Error("expected seeded artifact");
    writeFileSync(
      artifactPath(evidenceDir),
      JSON.stringify({
        ...current,
        editedRevisions: [
          {
            candidateId: "tc-1",
            provenance: {
              editedAt: "2026-06-08T12:00:00.000Z",
              editedBy: "human",
              editorLabel: "Alice",
            },
            editedFields: { steps: "not-an-array" },
          },
        ],
      }),
      "utf8",
    );

    expect(() => loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("throws EvidenceReadError for an edited revision with a blank-string list item", () => {
    const current = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    if (current === undefined) throw new Error("expected seeded artifact");
    writeFileSync(
      artifactPath(evidenceDir),
      JSON.stringify({
        ...current,
        editedRevisions: [
          {
            candidateId: "tc-1",
            provenance: {
              editedAt: "2026-06-08T12:00:00.000Z",
              editedBy: "human",
              editorLabel: "Alice",
            },
            // A blank ("") item is never a valid step — the read validator rejects it, matching
            // what the edit route enforces before persist (no write/read asymmetry).
            editedFields: { steps: ["ok", ""] },
          },
        ],
      }),
      "utf8",
    );

    expect(() => loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("loads an edited revision whose optional list was legitimately cleared to []", () => {
    const current = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    if (current === undefined) throw new Error("expected seeded artifact");
    writeFileSync(
      artifactPath(evidenceDir),
      JSON.stringify({
        ...current,
        editedRevisions: [
          {
            candidateId: "tc-1",
            provenance: {
              editedAt: "2026-06-08T12:00:00.000Z",
              editedBy: "human",
              editorLabel: "Alice",
            },
            editedFields: { preconditions: [], tags: [] },
          },
        ],
      }),
      "utf8",
    );

    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions?.[0]?.editedFields.preconditions).toEqual([]);
  });
});
