// Mutation-robust tests for bidi/control-char scrubbing at the parseGeneratedCandidates
// chokepoint (Issue #724 — security invariant: no unsafe code point survives into persisted
// candidate fields).
//
// Test B: parseGeneratedCandidates strips unsafe chars from all value-bearing fields.
// Test C: serializeExportBundle inherits clean text from the chokepoint across all formats.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import {
  QualityIntelligenceGeneration,
  regressionDefault,
} from "@oscharko-dev/keiko-quality-intelligence";
import { isUnsafeFormatCodePoint } from "../../domain/assertions.js";
import { serializeExportBundle } from "../../export/serialize.js";

// ─── Shared unsafe code points ────────────────────────────────────────────────

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

/** Returns true iff `s` contains no code point in the unsafe set. */
const hasNoUnsafeChar = (s: string): boolean => {
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isUnsafeFormatCodePoint(code)) return false;
  }
  return true;
};

// Embed one of each unsafe class in a string so one mutant kills the whole assertion.
const DIRTY_TEXT = [
  cp(0x202e), // RLO bidi override
  cp(0x200b), // ZWSP zero-width
  cp(0x0000), // NUL C0 control
  cp(0x0007), // BEL C0 control
  cp(0x007f), // DEL
  cp(0x0085), // NEL C1 control
  cp(0x200e), // LRM
  cp(0x061c), // ALM
  cp(0xfeff), // BOM
  cp(0x2066), // LRI isolate
].join("test");

// ─── Shared helpers ───────────────────────────────────────────────────────────

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("run-bidi-scrub-test");
const ATOM_ID = QualityIntelligence.asQualityIntelligenceEvidenceAtomId("qi-atom-bidi-01");

const baseInput = (): QualityIntelligenceGeneration.ParseGeneratedCandidatesInput => ({
  runId: RUN_ID,
  atomIds: [ATOM_ID],
  profile: regressionDefault,
  maxCandidates: 10,
});

const dirtyItem = (): Record<string, unknown> => ({
  title: `Title ${DIRTY_TEXT}`,
  steps: [`Step one ${DIRTY_TEXT}`, `Step two ${DIRTY_TEXT}`],
  preconditions: [`Pre ${DIRTY_TEXT}`],
  expectedResults: [`Expected ${DIRTY_TEXT}`],
  tags: [`tag-${DIRTY_TEXT}`],
  derivedFromEvidenceIndexes: [1],
  priority: "P1",
  riskClass: "functional",
});

const wrapInTestCases = (items: readonly unknown[]): string => JSON.stringify({ testCases: items });

// ─── Test B: parseGeneratedCandidates scrubs all value-bearing fields ─────────

describe("parseGeneratedCandidates — bidi/control-char scrub (Issue #724)", () => {
  it("strips unsafe chars from every persisted text field of a candidate", () => {
    // Kills: removing normaliseCandidateText from toStringList or buildCandidate.
    const raw = wrapInTestCases([dirtyItem()]);
    const result = QualityIntelligenceGeneration.parseGeneratedCandidates(raw, baseInput());
    expect(result.recovered).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c).toBeDefined();
    if (c === undefined) return;

    // Every string field must contain no unsafe code point.
    expect(hasNoUnsafeChar(c.title), "title").toBe(true);
    for (const step of c.steps) {
      expect(hasNoUnsafeChar(step), `step: ${step}`).toBe(true);
    }
    for (const pre of c.preconditions) {
      expect(hasNoUnsafeChar(pre), `precondition: ${pre}`).toBe(true);
    }
    for (const exp of c.expectedResults) {
      expect(hasNoUnsafeChar(exp), `expectedResult: ${exp}`).toBe(true);
    }
    for (const tag of c.tags) {
      expect(hasNoUnsafeChar(tag), `tag: ${tag}`).toBe(true);
    }
  });

  it("preserves clean text byte-identical (behaviour-preservation pin)", () => {
    // Kills: any normalisation that alters clean ASCII candidate text.
    const cleanItem = {
      title: "Login with valid credentials",
      steps: ["Navigate to login page", "Enter credentials", "Click submit"],
      preconditions: ["User is logged out"],
      expectedResults: ["User is redirected to dashboard"],
      tags: ["smoke"],
      derivedFromEvidenceIndexes: [1],
      priority: "P1",
      riskClass: "functional",
    };
    const raw = wrapInTestCases([cleanItem]);
    const result = QualityIntelligenceGeneration.parseGeneratedCandidates(raw, baseInput());
    expect(result.recovered).toBe(true);
    const c = result.candidates[0];
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.title).toBe("Login with valid credentials");
    expect(c.steps).toEqual(["Navigate to login page", "Enter credentials", "Click submit"]);
    expect(c.preconditions).toEqual(["User is logged out"]);
    expect(c.expectedResults).toEqual(["User is redirected to dashboard"]);
    expect(c.tags).toEqual(["smoke"]);
    // ID must be stable: re-parse yields the same id (content-hash over clean title).
    const result2 = QualityIntelligenceGeneration.parseGeneratedCandidates(raw, baseInput());
    expect(result2.candidates[0]?.id).toBe(c.id);
  });

  it("candidate ID is identical for dirty and equivalent clean title (strip is pre-hash)", () => {
    // The title used for ID derivation is the CLEANED title. A dirty title whose
    // cleaned form equals a clean title must yield the same ID — confirms strip
    // happens BEFORE hash derivation (normaliseCandidateText called in buildCandidate).
    const dirtyTitle = `Login with valid credentials${cp(0x202e)}`;
    const cleanTitle = "Login with valid credentials";
    const rawDirty = wrapInTestCases([
      {
        title: dirtyTitle,
        steps: ["Step one"],
        derivedFromEvidenceIndexes: [1],
        priority: "P1",
        riskClass: "functional",
      },
    ]);
    const rawClean = wrapInTestCases([
      {
        title: cleanTitle,
        steps: ["Step one"],
        derivedFromEvidenceIndexes: [1],
        priority: "P1",
        riskClass: "functional",
      },
    ]);
    const rDirty = QualityIntelligenceGeneration.parseGeneratedCandidates(rawDirty, baseInput());
    const rClean = QualityIntelligenceGeneration.parseGeneratedCandidates(rawClean, baseInput());
    expect(rDirty.candidates[0]?.id).toBe(rClean.candidates[0]?.id);
  });
});

// ─── Test C: export end-to-end invariant ─────────────────────────────────────

/** Build a minimal parsed candidate carrying dirty text through the pipeline. */
const parsedDirtyCandidate = (): QualityIntelligenceTestCaseCandidate => {
  const raw = wrapInTestCases([dirtyItem()]);
  const result = QualityIntelligenceGeneration.parseGeneratedCandidates(raw, baseInput());
  const c = result.candidates[0];
  if (c === undefined) throw new Error("fixture: candidate not parsed");
  return c;
};

function exportBundle(
  format: QualityIntelligenceExportBundle["targetAdapter"],
  candidate: QualityIntelligenceTestCaseCandidate,
  redactionAttested: boolean,
): QualityIntelligenceExportBundle {
  return {
    id: QualityIntelligence.asQualityIntelligenceExportBundleId(`qi-export-bidi-${format}`),
    runId: RUN_ID,
    targetAdapter: format,
    createdAt: "2026-06-13T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested,
    contents: [{ candidateId: candidate.id, coverageMapRefs: [], findingRefs: [] }],
  };
}

describe("serializeExportBundle — no unsafe code point survives into any format (Issue #724)", () => {
  const candidate = parsedDirtyCandidate();

  it("csv body contains no unsafe code point (kills: strip removed from csv path)", () => {
    const bundle = exportBundle("csv", candidate, false);
    const { body } = serializeExportBundle(bundle, [candidate]);
    expect(hasNoUnsafeChar(body), "csv body").toBe(true);
  });

  it("json body contains no unsafe code point (kills: strip removed from json path)", () => {
    const bundle = exportBundle("json", candidate, false);
    const { body } = serializeExportBundle(bundle, [candidate]);
    expect(hasNoUnsafeChar(body), "json body").toBe(true);
  });

  it("markdown body contains no unsafe code point (kills: strip removed from markdown path)", () => {
    const bundle = exportBundle("markdown", candidate, false);
    const { body } = serializeExportBundle(bundle, [candidate]);
    expect(hasNoUnsafeChar(body), "markdown body").toBe(true);
  });

  it("plain-text body contains no unsafe code point (kills: strip removed from plain-text path)", () => {
    const bundle = exportBundle("plain-text", candidate, false);
    const { body } = serializeExportBundle(bundle, [candidate]);
    expect(hasNoUnsafeChar(body), "plain-text body").toBe(true);
  });

  it("quality-center body contains no unsafe code point (kills: strip removed from quality-center path)", () => {
    // quality-center requires redactionAttested: true
    const bundle = exportBundle("quality-center", candidate, true);
    const { body } = serializeExportBundle(bundle, [candidate]);
    expect(hasNoUnsafeChar(body), "quality-center body").toBe(true);
  });
});
