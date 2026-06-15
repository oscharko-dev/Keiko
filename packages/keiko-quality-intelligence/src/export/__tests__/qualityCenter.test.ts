// Quality Center export adapter tests (Epic #711, Issue #722).
//
// The adapter is preview-only: it renders a deterministic dry-run mapping of approved candidates to
// a Quality Center work-item shape and states that a live write requires a configured connector. The
// 403 write-disabled guard lives in the route; this leaf only proves the preview is deterministic,
// structurally sound, and redaction-clean.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToQualityCenter } from "../adapters/qualityCenter.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-qc");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["Logged in"],
    steps: ["Open", "Submit"],
    expectedResults: ["Saved"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-qc"),
    runId: RUN,
    targetAdapter: "quality-center",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToQualityCenter", () => {
  it("renders a dry-run preview that names the connector requirement for a live write", () => {
    const c = candidate("tc-1", "Login succeeds");
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("Quality Center Export Preview");
    expect(out).toMatch(/dry-run preview\. Live export requires a configured connector/iu);
    expect(out).toContain("QC-0001 Login succeeds");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToQualityCenter(b, [c])).toBe(adaptToQualityCenter(b, [c]));
  });

  it("orders entries by candidate id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToQualityCenter(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("folds embedded newlines so each field stays on its own row", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "Title\nbreak"),
      steps: ["Open\nthe page", "Submit"],
    };
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("QC-0001 Title break");
    expect(out).toContain("Steps:        Open the page | Submit");
    expect(out).not.toContain("\nthe page");
  });

  it("renders empty field lists as (none)", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      preconditions: [],
      steps: [],
      expectedResults: [],
      tags: [],
    };
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("Tags:         (none)");
    expect(out).toContain("Steps:        (none)");
  });

  it("emits no ISO timestamp and no provider URL / token / prompt scaffolding", () => {
    const c = candidate("tc-1", "Plain redacted title");
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/bearer\s|api[_-]?key|sk-[a-z0-9]/iu);
    expect(out).not.toMatch(/system prompt|you are an? /iu);
  });

  it("renders every key-value field with its label and the candidate value", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-fields", "Login works"),
      priority: "P2",
      riskClass: "regression",
      status: "accepted",
      tags: ["smoke", "auth"],
      preconditions: ["User exists"],
      steps: ["Open login", "Submit"],
      expectedResults: ["Dashboard shown"],
    };
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("QC-0001 Login works");
    // Each label line must carry the correct value. The label→value gap is matched as a run of
    // spaces (` +`) so the assertion pins the label text and the value without being brittle on the
    // exact padding width — a dropped line, a renamed label, or a wrong value all fail.
    expect(out).toMatch(/\n {2}ID: +tc-fields(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Priority: +P2(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Risk class: +regression(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Status: +accepted(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Tags: +smoke \| auth(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Precond: +User exists(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Steps: +Open login \| Submit(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Expected: +Dashboard shown(?:\n|$)/u);
  });

  it("numbers two real candidates contiguously as QC-0001 and QC-0002", () => {
    const a = candidate("tc-1", "Alpha");
    const b = candidate("tc-2", "Beta");
    const out = adaptToQualityCenter(bundle([a, b]), [a, b]);
    expect(out).toContain("QC-0001 Alpha");
    expect(out).toContain("QC-0002 Beta");
  });

  it("skips a bundle entry whose candidate is absent without burning a sequence number", () => {
    const a = candidate("tc-1", "Alpha");
    const g = candidate("tc-3", "Gamma");
    // `contents` references tc-1, tc-2 (a phantom absent from the candidates array), and tc-3.
    const withPhantom: QualityIntelligenceExportBundle = {
      ...bundle([a, g]),
      contents: [
        {
          candidateId: Q.asQualityIntelligenceTestCaseId("tc-1"),
          coverageMapRefs: [],
          findingRefs: [],
        },
        {
          candidateId: Q.asQualityIntelligenceTestCaseId("tc-2"),
          coverageMapRefs: [],
          findingRefs: [],
        },
        {
          candidateId: Q.asQualityIntelligenceTestCaseId("tc-3"),
          coverageMapRefs: [],
          findingRefs: [],
        },
      ],
    };
    const out = adaptToQualityCenter(withPhantom, [a, g]);
    expect(out).toContain("QC-0001 Alpha");
    // Gamma must take QC-0002, NOT QC-0003 — the skipped phantom entry must not consume a number.
    expect(out).toContain("QC-0002 Gamma");
    expect(out).not.toContain("QC-0003");
    // The phantom id is never rendered.
    expect(out).not.toContain("tc-2");
  });

  it("joins three-item lists with ' | ' in input order across every list field", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "Three"),
      tags: ["alpha", "beta", "gamma"],
      preconditions: ["p1", "p2", "p3"],
      steps: ["s1", "s2", "s3"],
      expectedResults: ["e1", "e2", "e3"],
    };
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toMatch(/\n {2}Tags: +alpha \| beta \| gamma(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Precond: +p1 \| p2 \| p3(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Steps: +s1 \| s2 \| s3(?:\n|$)/u);
    expect(out).toMatch(/\n {2}Expected: +e1 \| e2 \| e3(?:\n|$)/u);
  });

  it("throws when a TMS-targeted bundle does not attest redaction (invariant enforced at the adapter)", () => {
    const c = candidate("tc-1", "X");
    const unattested: QualityIntelligenceExportBundle = {
      ...bundle([c]),
      redactionAttested: false,
    };
    expect(() => adaptToQualityCenter(unattested, [c])).toThrow(/redactionAttested/u);
  });

  it("throws when the integrity hash is not a lowercase sha256 hex string", () => {
    const c = candidate("tc-1", "X");
    const badHash: QualityIntelligenceExportBundle = {
      ...bundle([c]),
      integrityHashSha256Hex: "not-a-hash",
    };
    expect(() => adaptToQualityCenter(badHash, [c])).toThrow(/integrity hash/iu);
  });
});
