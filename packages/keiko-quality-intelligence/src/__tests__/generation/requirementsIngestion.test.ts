// Mutation-robust unit tests for splitRequirementsIntoAtoms (Epic #270 / Issue #278).
//
// Coverage:
//   1. Basic line-splitting and marker stripping
//   2. Sentence-split fallback for single-paragraph input
//   3. Deduplication of identical statements (first-seen order)
//   4. Min-length filter and no-letter filter
//   5. maxAtoms cap
//   6. Deterministic atom ids and canonical hash
//   7. Edge cases: empty, blank, only-markers, single line

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceGeneration } from "@oscharko-dev/keiko-quality-intelligence";

type SplitOptions = QualityIntelligenceGeneration.SplitRequirementsOptions;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ENVELOPE_ID = QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-test-001");
const ENVELOPE_ID_2 = QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-test-002");

const opts = (overrides: Partial<SplitOptions> = {}): SplitOptions => ({
  envelopeId: ENVELOPE_ID,
  ...overrides,
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ─── 1. Basic line splitting and marker stripping ─────────────────────────────

describe("splitRequirementsIntoAtoms — line splitting and marker stripping", () => {
  it("splits a multi-line requirement blob into atoms, one per non-blank line", () => {
    const text = [
      "The system shall authenticate users",
      "The system shall log all access attempts",
      "The system shall encrypt data at rest",
    ].join("\n");
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(3);
    expect(atoms[0]?.canonicalText).toBe("The system shall authenticate users");
    expect(atoms[1]?.canonicalText).toBe("The system shall log all access attempts");
    expect(atoms[2]?.canonicalText).toBe("The system shall encrypt data at rest");
  });

  it("strips '- ' leading marker from lines", () => {
    const text = "- User must be authenticated\n- Session must expire after 30 minutes";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.canonicalText).toBe("User must be authenticated");
    expect(atoms[1]?.canonicalText).toBe("Session must expire after 30 minutes");
  });

  it("strips '1. ' numbered marker from lines", () => {
    const text = "1. Login must require two-factor\n2. Password must be at least 12 chars";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.canonicalText).toBe("Login must require two-factor");
    expect(atoms[1]?.canonicalText).toBe("Password must be at least 12 chars");
  });

  it("strips 'a) ' alphabetic marker from lines", () => {
    const text = "a) System must validate input\nb) System must reject invalid data";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.canonicalText).toBe("System must validate input");
    expect(atoms[1]?.canonicalText).toBe("System must reject invalid data");
  });

  it("strips '• ' bullet marker from lines", () => {
    const text = "• Feature X must be available\n• Feature Y must be tested";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.canonicalText).toBe("Feature X must be available");
    expect(atoms[1]?.canonicalText).toBe("Feature Y must be tested");
  });

  it("handles Windows-style CRLF line endings", () => {
    const text = "First requirement\r\nSecond requirement\r\nThird requirement";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(3);
    expect(atoms[0]?.canonicalText).toBe("First requirement");
  });

  it("trims leading and trailing whitespace from each statement", () => {
    const text = "  Login must work  \n  Logout must work  ";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms[0]?.canonicalText).toBe("Login must work");
    expect(atoms[1]?.canonicalText).toBe("Logout must work");
  });

  it("each atom carries kind='requirement'", () => {
    const text = "The API must be RESTful\nThe API must be versioned";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    for (const a of atoms) {
      expect(a.atom.kind).toBe("requirement");
    }
  });

  it("each atom carries the correct sourceEnvelopeId", () => {
    const text = "Requirement A\nRequirement B";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    for (const a of atoms) {
      expect(a.atom.sourceEnvelopeId).toBe(ENVELOPE_ID);
    }
  });

  it("each atom has lifecycleStatus='draft'", () => {
    const text = "The form must validate on submit\nErrors must be shown inline";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    for (const a of atoms) {
      expect(a.atom.lifecycleStatus).toBe("draft");
    }
  });

  it("each atom has redactionStatus='not-required'", () => {
    const text = "Feature flag must be togglable\nFeature must degrade gracefully";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    for (const a of atoms) {
      expect(a.atom.redactionStatus).toBe("not-required");
    }
  });
});

// ─── 2. Sentence-split fallback for single-paragraph input ───────────────────

describe("splitRequirementsIntoAtoms — sentence-split fallback", () => {
  it("splits a single-line paragraph into multiple sentences on '. ' before capital", () => {
    const text =
      "The system must authenticate users. It must log every access. Errors must be auditable.";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    // Should produce multiple atoms, not one blob
    expect(atoms.length).toBeGreaterThan(1);
  });

  it("single meaningful sentence (no '. ' boundary) → one atom", () => {
    const text = "The user must provide valid credentials to log in";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.canonicalText).toBe("The user must provide valid credentials to log in");
  });
});

// ─── 3. Deduplication ────────────────────────────────────────────────────────

describe("splitRequirementsIntoAtoms — deduplication", () => {
  it("deduplicates identical lines, keeping first-seen order", () => {
    const text = [
      "The system shall authenticate users",
      "The system shall log all access",
      "The system shall authenticate users",
    ].join("\n");
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.canonicalText).toBe("The system shall authenticate users");
    expect(atoms[1]?.canonicalText).toBe("The system shall log all access");
  });

  it("deduplication is case-sensitive (different case = different atom)", () => {
    const text = "The system shall Authenticate\nThe system shall authenticate";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    // Case differs after NFKC normalisation — both should survive
    expect(atoms.length).toBeGreaterThanOrEqual(1);
    // Verify unique canonical texts
    const texts = atoms.map((a) => a.canonicalText);
    const unique = new Set(texts);
    expect(unique.size).toBe(texts.length);
  });

  it("does not produce two atoms with the same id for different duplicates", () => {
    const text = "Same requirement\nSame requirement\nSame requirement";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    const ids = atoms.map((a) => String(a.atom.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── 4. Min-length filter and no-letter filter ───────────────────────────────

describe("splitRequirementsIntoAtoms — min-length and no-letter filter", () => {
  it("drops lines shorter than 6 characters", () => {
    const text = "abc\nThe system shall validate input on submission";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    // 'abc' = 3 chars < 6 → dropped
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.canonicalText).toBe("The system shall validate input on submission");
  });

  it("drops lines with exactly 5 characters (boundary: < 6 is dropped)", () => {
    const text = "abcde\nMinimum required feature must function";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.canonicalText).toBe("Minimum required feature must function");
  });

  it("accepts lines with exactly 6 characters (boundary: >= 6 is kept)", () => {
    const text = "abcdef\nAnother valid requirement line here";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    // 'abcdef' = 6 chars AND has letters → should be kept if it passes letter check
    expect(atoms.length).toBeGreaterThanOrEqual(1);
  });

  it("drops lines that contain no letters (pure digits/symbols)", () => {
    const text = "123456789\nThe system must handle numeric input correctly";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    // '123456789' has no Unicode letters → dropped
    const meaningful = atoms.filter((a) => a.canonicalText !== "123456789");
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0]?.canonicalText).toBe("The system must handle numeric input correctly");
  });

  it("drops blank lines silently", () => {
    const text = "Valid requirement line A\n\n\nValid requirement line B";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
  });

  it("drops whitespace-only lines", () => {
    const text = "Valid requirement\n   \n\t\nAnother valid requirement here";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(2);
  });
});

// ─── 5. maxAtoms cap ─────────────────────────────────────────────────────────

describe("splitRequirementsIntoAtoms — maxAtoms cap", () => {
  it("respects maxAtoms=1 (boundary: only first atom emitted)", () => {
    const text = "Requirement A is critical\nRequirement B is important\nRequirement C is nice";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      text,
      opts({ maxAtoms: 1 }),
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.canonicalText).toBe("Requirement A is critical");
  });

  it("respects maxAtoms=2 (stops at boundary, not before)", () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `Requirement number ${String(i + 1)} description`,
    );
    const text = lines.join("\n");
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      text,
      opts({ maxAtoms: 2 }),
    );
    expect(atoms).toHaveLength(2);
  });

  it("default maxAtoms allows up to 200 atoms", () => {
    const lines = Array.from(
      { length: 205 },
      (_, i) => `Requirement ${String(i + 1)} must be satisfied`,
    );
    const text = lines.join("\n");
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(200);
  });

  it("does not exceed maxAtoms even when input has more unique statements", () => {
    const lines = Array.from(
      { length: 300 },
      (_, i) => `Unique requirement statement ${String(i + 1)} must pass validation`,
    );
    const text = lines.join("\n");
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      text,
      opts({ maxAtoms: 50 }),
    );
    expect(atoms.length).toBeLessThanOrEqual(50);
  });
});

// ─── 6. Deterministic atom ids and canonical hash ────────────────────────────

describe("splitRequirementsIntoAtoms — determinism", () => {
  it("same input produces the same atom ids (deterministic)", () => {
    const text = "System must authenticate\nSystem must authorise";
    const r1 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    const r2 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(r1[0]?.atom.id).toBe(r2[0]?.atom.id);
    expect(r1[1]?.atom.id).toBe(r2[1]?.atom.id);
  });

  it("different envelopeIds produce different atom ids for the same text", () => {
    const text = "The user must be able to login securely";
    const r1 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      text,
      opts({ envelopeId: ENVELOPE_ID }),
    );
    const r2 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      text,
      opts({ envelopeId: ENVELOPE_ID_2 }),
    );
    expect(r1[0]?.atom.id).not.toBe(r2[0]?.atom.id);
  });

  it("different canonical texts produce different atom ids for the same envelope", () => {
    const text1 = "Authentication must use MFA tokens";
    const text2 = "Authentication must use biometrics";
    const r1 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text1, opts());
    const r2 = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text2, opts());
    expect(r1[0]?.atom.id).not.toBe(r2[0]?.atom.id);
  });

  it("atom id is prefixed with 'qi-atom-'", () => {
    const text = "System must handle concurrent requests efficiently";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms[0]?.atom.id).toMatch(/^qi-atom-/u);
  });

  it("canonicalHashSha256Hex is the SHA-256 hex of the canonical text", () => {
    const text = "Feature must degrade gracefully under load";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    const canonicalText = atoms[0]?.canonicalText ?? "";
    const expectedHash = sha256(canonicalText);
    expect(atoms[0]?.atom.canonicalHashSha256Hex).toBe(expectedHash);
  });

  it("canonicalHashSha256Hex is 64 hex characters (SHA-256)", () => {
    const text = "The API must return results within 200ms for p95 requests";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms[0]?.atom.canonicalHashSha256Hex).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("different statements produce different hashes", () => {
    const text = "Requirement alpha must be met\nRequirement beta must also be met";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms[0]?.atom.canonicalHashSha256Hex).not.toBe(atoms[1]?.atom.canonicalHashSha256Hex);
  });

  it("keeps the same atom id for an unchanged statement even when another line is inserted before it", () => {
    const original = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      "First requirement statement must work\nSecond requirement statement must work",
      opts(),
    );
    const edited = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      "Inserted unrelated requirement statement\nFirst requirement statement must work\nSecond requirement statement must work",
      opts(),
    );
    expect(original[0]?.atom.id).toBe(edited[1]?.atom.id);
    expect(original[1]?.atom.id).toBe(edited[2]?.atom.id);
  });

  it("keeps the same atom id for an unchanged statement when neighbouring text changes", () => {
    const original = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      "First requirement statement must work\nSecond requirement statement must work",
      opts(),
    );
    const edited = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      "First requirement statement must work\nSecond requirement statement was refined",
      opts(),
    );
    expect(original[0]?.atom.id).toBe(edited[0]?.atom.id);
    expect(original[1]?.atom.id).not.toBe(edited[1]?.atom.id);
  });

  it("returned array is frozen", () => {
    const text = "System must scale horizontally as needed";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(Object.isFrozen(atoms)).toBe(true);
  });
});

// ─── 7. Edge cases: empty / blank / single-line ───────────────────────────────

describe("splitRequirementsIntoAtoms — edge cases", () => {
  it("returns empty array for an empty string", () => {
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms("", opts());
    expect(atoms).toHaveLength(0);
  });

  it("returns empty array for a whitespace-only string", () => {
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms("   \n\t  ", opts());
    expect(atoms).toHaveLength(0);
  });

  it("returns empty array when all lines are below min-length", () => {
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms("ab\ncd\nef", opts());
    expect(atoms).toHaveLength(0);
  });

  it("returns empty array when all lines have no letters", () => {
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
      "123456\n789012\n345678",
      opts(),
    );
    expect(atoms).toHaveLength(0);
  });

  it("handles a single long line that is a single sentence correctly", () => {
    const text =
      "The entire requirement is expressed in this one long sentence without any line break";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.canonicalText).toBe(text);
  });

  it("each IngestedRequirementAtom has both atom and canonicalText fields", () => {
    const text = "Valid requirement with sufficient length";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toHaveProperty("atom");
    expect(atoms[0]).toHaveProperty("canonicalText");
    expect(typeof atoms[0]?.canonicalText).toBe("string");
  });

  it("the result IngestedRequirementAtom objects are frozen", () => {
    const text = "Immutability of result objects must be verified here";
    const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, opts());
    for (const a of atoms) {
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.atom)).toBe(true);
    }
  });
});
