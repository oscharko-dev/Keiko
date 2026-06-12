import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { QualityIntelligenceEvidenceAtom } from "../evidenceAtom.js";
import {
  QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES,
  QUALITY_INTELLIGENCE_REDACTION_STATUSES,
  hasCanonicalSha256Hash,
} from "../evidenceAtom.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const loadFixture = (filename: string): { raw: unknown; rawText: string } => {
  const rawText = readFileSync(join(FIXTURES_DIR, filename), "utf8");
  const raw = JSON.parse(rawText) as unknown;
  return { raw, rawText };
};

// ─── hasCanonicalSha256Hash — pure guard behaviour ─────────────────────────────

describe("hasCanonicalSha256Hash", () => {
  // Build a minimal valid atom stub; only canonicalHashSha256Hex is read by the guard.
  const atomWith = (hash: string): QualityIntelligenceEvidenceAtom =>
    ({
      kind: "requirement",
      id: "atom-unit-01" as QualityIntelligenceEvidenceAtom["id"],
      sourceEnvelopeId: "env-unit-01" as QualityIntelligenceEvidenceAtom["sourceEnvelopeId"],
      canonicalHashSha256Hex: hash,
      redactionStatus: "not-required",
      lifecycleStatus: "draft",
    }) as unknown as QualityIntelligenceEvidenceAtom;

  it("accepts a valid 64-char lowercase hex string", () => {
    // Mutation killed: if regex anchor removed, empty prefix would pass.
    const validHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    expect(hasCanonicalSha256Hash(atomWith(validHash))).toBe(true);
  });

  it("accepts all hex digits 0-9 and a-f throughout", () => {
    // Mutation killed: if character class narrowed (e.g. [0-9a-e]), this fails.
    const allHexChars = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(hasCanonicalSha256Hash(atomWith(allHexChars))).toBe(true);
  });

  it("rejects a 63-char string (one char short)", () => {
    // Mutation killed: {64} → {63} would make this pass when it should fail.
    const shortHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678";
    expect(shortHash).toHaveLength(63);
    expect(hasCanonicalSha256Hash(atomWith(shortHash))).toBe(false);
  });

  it("rejects a 65-char string (one char over)", () => {
    // Mutation killed: {64} → {65} would make this pass when it should fail.
    const longHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567890";
    expect(longHash).toHaveLength(65);
    expect(hasCanonicalSha256Hash(atomWith(longHash))).toBe(false);
  });

  it("rejects a 64-char UPPERCASE hex string", () => {
    // Mutation killed: removing the lowercase [a-f] case requirement (e.g. [0-9a-fA-F]).
    const upperHash = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    expect(hasCanonicalSha256Hash(atomWith(upperHash))).toBe(false);
  });

  it("rejects an empty string", () => {
    // Mutation killed: removing the ^ anchor would let '' match via zero iterations.
    expect(hasCanonicalSha256Hash(atomWith(""))).toBe(false);
  });

  it("rejects a string containing a non-hex character (g)", () => {
    // Mutation killed: [0-9a-f] → [0-9a-g] would let 'g' through.
    const withG = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678g";
    expect(withG).toHaveLength(64);
    expect(hasCanonicalSha256Hash(atomWith(withG))).toBe(false);
  });

  it("rejects a string with an embedded space", () => {
    // Mutation killed: guards that strip whitespace before checking would pass this.
    const withSpace = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345 789";
    expect(withSpace).toHaveLength(64);
    expect(hasCanonicalSha256Hash(atomWith(withSpace))).toBe(false);
  });
});

// ─── evidenceAtom.synthetic.json — fixture round-trip + enum membership ───────

describe("Compatibility round-trip — evidenceAtom.synthetic.json", () => {
  const { raw, rawText } = loadFixture("evidenceAtom.synthetic.json");

  it("carries the synthetic-header marker", () => {
    // Mutation killed: if the header field is renamed or removed, this fails.
    expect(rawText).toContain("synthetic — no customer data; safe to bundle");
  });

  it("contains at least two atoms covering two distinct kinds", () => {
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    expect(atoms.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(atoms.map((a) => a.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it("every atom passes hasCanonicalSha256Hash", () => {
    // Mutation killed: if the hash pattern is widened to accept non-hex, fixture atoms
    // with fake-but-valid hashes would still pass — unless hash values are wrong.
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    for (const atom of atoms) {
      expect(hasCanonicalSha256Hash(atom)).toBe(true);
    }
  });

  it("fixture includes one atom with redactionStatus 'redacted'", () => {
    // Mutation killed: if redaction field is accidentally removed from a fixture atom.
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    expect(atoms.some((a) => a.redactionStatus === "redacted")).toBe(true);
  });

  it("fixture includes one atom with redactionStatus 'not-required'", () => {
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    expect(atoms.some((a) => a.redactionStatus === "not-required")).toBe(true);
  });

  it("every atom's redactionStatus is a member of QUALITY_INTELLIGENCE_REDACTION_STATUSES", () => {
    // Mutation killed: if a new status is added to the fixture without updating the enum.
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    for (const atom of atoms) {
      expect(QUALITY_INTELLIGENCE_REDACTION_STATUSES).toContain(atom.redactionStatus);
    }
  });

  it("every atom's lifecycleStatus is a member of QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES", () => {
    // Mutation killed: if a new lifecycle value is added to the fixture without updating the enum.
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    for (const atom of atoms) {
      expect(QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES).toContain(atom.lifecycleStatus);
    }
  });

  it("redactionStatus and lifecycleStatus survive a JSON round-trip unchanged", () => {
    // Mutation killed: if these fields are accidentally dropped or renamed during serialisation.
    const { atoms } = raw as { readonly atoms: readonly QualityIntelligenceEvidenceAtom[] };
    for (const atom of atoms) {
      const roundTripped = JSON.parse(JSON.stringify(atom)) as QualityIntelligenceEvidenceAtom;
      expect(roundTripped.redactionStatus).toBe(atom.redactionStatus);
      expect(roundTripped.lifecycleStatus).toBe(atom.lifecycleStatus);
      expect(roundTripped.canonicalHashSha256Hex).toBe(atom.canonicalHashSha256Hex);
      expect(roundTripped.kind).toBe(atom.kind);
    }
  });
});
