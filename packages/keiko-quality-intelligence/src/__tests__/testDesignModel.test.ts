import { describe, expect, it } from "vitest";

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { deriveIntent } from "../domain/intentDerivation.js";
import type { IntentSummary } from "../domain/intentDerivation.js";
import { STRUCTURAL_BASELINE_MARKER } from "../domain/figma/screenIrTestBaseline.js";
import { bankingDefault, regressionDefault } from "../domain/policyProfile.js";
import {
  designTestCaseCandidates,
  DETERMINISTIC_BASELINE_PROVENANCE_TAG,
  parseFigmaScreenHeaderName,
} from "../domain/testDesignModel.js";
import { loadFixture, type LoadedFixture } from "./_fixtureLoader.js";

// Unsafe bidi / zero-width / C0-C1 / DEL code points that must never reach a
// persisted (hence exported) candidate field. A code-point Set scan is used
// instead of a control-range regex literal (forbidden by no-control-regex).
const UNSAFE_CODE_POINTS = new Set<number>([
  0x0007, 0x007f, 0x009d, 0x061c, 0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const hasUnsafeCodePoint = (value: string): boolean => {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && UNSAFE_CODE_POINTS.has(cp)) {
      return true;
    }
  }
  return false;
};

const allFieldStrings = (
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly string[] => [
  candidate.title,
  ...candidate.preconditions,
  ...candidate.steps,
  ...candidate.expectedResults,
  ...candidate.tags,
];

// noUncheckedIndexedAccess + no-non-null-assertion: narrow via a throw-helper.
const firstEnvelope = (
  fixture: LoadedFixture,
): QualityIntelligence.QualityIntelligenceSourceEnvelope => {
  const envelope = fixture.envelopes[0];
  if (envelope === undefined) {
    throw new Error("fixture exposes no source envelopes");
  }
  return envelope;
};

// Build code points without embedding literal control/bidi bytes in the source file.
const RLO = String.fromCodePoint(0x202e);
const ZW = String.fromCodePoint(0x200b);
const C1 = String.fromCodePoint(0x009d);
const BOM = String.fromCodePoint(0xfeff);

describe("designTestCaseCandidates", () => {
  it("returns the empty array for an empty atom list", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const result = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [],
    });
    expect(result).toEqual([]);
  });

  it("derives one candidate per atom", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const result = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(result.length).toBe(fixture.atoms.length);
    for (const candidate of result) {
      expect(candidate.status).toBe("proposed");
      expect(candidate.runId).toBe(fixture.runId);
      expect(candidate.steps.length).toBeGreaterThan(0);
      expect(candidate.expectedResults.length).toBeGreaterThan(0);
    }
  });

  it("derives deterministic candidate IDs: same input -> same IDs", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const first = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const second = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
  });

  it("derives the same candidate IDs when the input atom order is shuffled", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const inOrder = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const reversed = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [...fixture.atoms].reverse(),
    });
    const inOrderIds = [...inOrder.map((candidate) => candidate.id)].sort();
    const reversedIds = [...reversed.map((candidate) => candidate.id)].sort();
    expect(inOrderIds).toEqual(reversedIds);
  });

  it("derives the same candidate IDs when only the run id changes", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const first = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const second = designTestCaseCandidates({
      runId: "qi-run-different" as QualityIntelligence.QualityIntelligenceRunId,
      intent,
      atoms: fixture.atoms,
    });
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
    expect(first.map((candidate) => candidate.runId)).not.toEqual(
      second.map((candidate) => candidate.runId),
    );
  });

  it("round-trips through JSON without mutation", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const round: unknown = JSON.parse(JSON.stringify(candidates));
    expect(round).toEqual(candidates);
  });

  // Render-layer consumers (presenter scripts + the product CandidatesPane) sort
  // deterministic-baseline candidates to the END so the judged model-delta candidates lead the
  // user-facing deliverable. The discriminator must be an EXPLICIT provenance tag, not a null
  // qualityVerdict (also null when the judge stage is skipped). The model-delta builder
  // (parseGeneratedCandidates) never emits this tag, so its absence reliably distinguishes a judged
  // candidate from a determinism-floor stub. The persisted manifest order itself is unchanged.
  it("tags every deterministic-baseline candidate with the provenance discriminator", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    }
  });

  it("keeps the provenance tag additive — existing risk-class/theme tags survive", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const first = candidates[0];
    if (first === undefined) {
      throw new Error("fixture produced no candidates");
    }
    expect(first.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    expect(first.tags.some((tag) => tag.startsWith("risk-class:"))).toBe(true);
    // Still canonical: sorted ascending and free of duplicates.
    expect([...first.tags]).toEqual([...first.tags].sort());
    expect(new Set(first.tags).size).toBe(first.tags.length);
  });

  it("uses supplied atom canonical text to produce source-specific baseline candidates", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const atomTextById = new Map(
      fixture.atoms.map((atom, index) => [
        String(atom.id),
        `REQ-AUTH-${String(index + 1).padStart(3, "0")}: Lock the account after five failed login attempts.`,
      ]),
    );

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
      atomTextById,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const atomId = String(candidate.derivedFromAtomIds[0]);
      const sourceRequirement = atomTextById.get(atomId);
      expect(sourceRequirement).toBeDefined();
      if (sourceRequirement === undefined) throw new Error("missing source requirement");
      expect(candidate.title).toContain(sourceRequirement);
      expect(candidate.title).toMatch(/^#\d{3} Prüfe /u);
      expect(candidate.preconditions).toContain(`Quellanforderung: ${sourceRequirement}`);
      expect(candidate.steps.join("\n")).toContain(sourceRequirement);
      expect(candidate.expectedResults.join("\n")).toContain(sourceRequirement);
      expect(candidate.expectedResults.join("\n")).toContain("Das beobachtete Verhalten erfüllt");
      expect(candidate.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    }
  });

  it("emits a CLEAN structural candidate for a Figma screen baseline atom (no atom-id/hash stub)", () => {
    // A Figma screen atom's canonical text is a Screen-IR structural baseline, not a prose
    // requirement. The generic template degenerates it into a "#001 Prüfe <dump> … Öffne den
    // <suffix>-Ablauf … für Atom <id> … Evidenz-Atom <hash> bleibt kanonisch" stub; the figma path
    // must instead emit a clean, screen-scoped structural test. This case RED-fails the pre-fix code.
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const screenName = "Vorhaben + Angebote (Aktionen erforderlich) ID-001.2_v2";
    const baselineText = [
      `1:121867 (${screenName})`,
      `Screen: ${screenName} [1:121867]`,
      "Structural test baseline (deterministic, derived from Screen-IR):",
      "- (screen-render) Screen renders without layout errors",
      "- (control-action) Primary button triggers its action",
      "- (a11y) Text contrast meets WCAG AA",
    ].join("\n");
    const firstAtom = fixture.atoms[0];
    if (firstAtom === undefined) throw new Error("fixture exposes no atoms");
    const atomTextById = new Map([[String(firstAtom.id), baselineText]]);

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [firstAtom],
      atomTextById,
    });
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("no candidate produced");

    // Clean, screen-scoped structural candidate — names the screen, no generic prose-requirement stub.
    expect(candidate.title).toMatch(/^#\d{3} Strukturelle Baseline-Prüfung: /u);
    expect(candidate.title).toContain(screenName);
    expect(candidate.preconditions).toContain(`Der Screen "${screenName}" ist geöffnet.`);

    const allText = [
      candidate.title,
      ...candidate.preconditions,
      ...candidate.steps,
      ...candidate.expectedResults,
    ].join("\n");
    // None of the pre-fix machine-internal noise may leak into the user-facing test case.
    expect(allText).not.toContain("Quellanforderung:");
    expect(allText).not.toContain("bleibt kanonisch");
    expect(allText).not.toContain("Servicepfad");
    expect(allText).not.toContain("Structural test baseline (deterministic");
    expect(allText).not.toContain(String(firstAtom.id));
    expect(allText).not.toContain(firstAtom.canonicalHashSha256Hex.slice(0, 12));

    // Still a tagged deterministic-baseline candidate with usable steps + expectations.
    expect(candidate.tags).toContain(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
    expect(candidate.steps.length).toBeGreaterThan(0);
    expect(candidate.expectedResults.length).toBeGreaterThan(0);
  });

  // Regression coverage for the S8786 rewrite of the internal Figma screen-header parser: the
  // original `/^Screen:\s+(.+?)\s+\[[^\]]+\]$/u` had unbounded `\s+` runs on either side of the
  // lazy `(.+?)` overlapping with `.` (which also matches whitespace), so a long non-matching
  // "Screen:" line drove severe backtracking (empirically ~10s at 4,000 chars pre-fix on this
  // machine). A first fix bounded both `\s+` to `{1,20}`, which caps the worst case but — per the
  // dedicated `parseFigmaScreenHeaderName` capture-correctness suite below — changes what gets
  // captured once a separator exceeds 20 chars, and raising that bound only makes the SAME
  // catastrophic backtracking reachable again (worst case scales with bound² × line length). The
  // header is now parsed with a manual, non-backtracking scan (indexOf/lastIndexOf + bounded
  // while-loops), so the worst case is linear for every input shape and there is no bound at all.
  it("stays fast against an adversarial all-whitespace Screen header (no closing bracket)", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const adversarialHeader = `Screen:${" ".repeat(20_000)}`; // never reaches `\[[^\]]+\]$`
    const baselineText = [
      adversarialHeader,
      STRUCTURAL_BASELINE_MARKER,
      "- (screen-render) x",
    ].join("\n");
    const firstAtom = fixture.atoms[0];
    if (firstAtom === undefined) throw new Error("fixture exposes no atoms");
    const atomTextById = new Map([[String(firstAtom.id), baselineText]]);

    const start = Date.now();
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [firstAtom],
      atomTextById,
    });
    expect(Date.now() - start).toBeLessThan(300);
    // No screen name could be parsed out of the header, so it falls back to the generic template
    // rather than throwing or hanging.
    expect(candidates.length).toBe(1);
  });
});

// Adversarial verifier finding (second remediation pass): the S8786 fix that bounded
// FIGMA_SCREEN_HEADER's two separating `\s+` runs to `{1,20}` is NOT capture-equivalent to the
// original unbounded pattern — once a separator run exceeds 20 chars, the excess whitespace bleeds
// into the `(.+?)` capture instead of being consumed by the separator. `PRIOR_BOUNDED_PATTERN`
// below is that exact bounded regex, kept ONLY to prove the defect it had (RED before this fix);
// `parseFigmaScreenHeaderName` is the corrected, non-backtracking replacement (GREEN after this
// fix) that never bleeds separator whitespace into the name, for any separator width — it has no
// quantifier left to bound in the first place.
describe("parseFigmaScreenHeaderName — capture correctness (S8786 verifier regression)", () => {
  const PRIOR_BOUNDED_PATTERN = /^Screen:\s{1,20}(.+?)\s{1,20}\[[^\]]+\]$/u;

  it("never bleeds a >20-char leading separator into the captured name", () => {
    const line = `Screen:${" ".repeat(21)}Name [id]`;
    // Proves the prior bounded regex actually had the defect the verifier reported.
    expect(PRIOR_BOUNDED_PATTERN.exec(line)?.[1]).toBe(" Name");
    // The corrected parser is not capture-lossy for the same input.
    expect(parseFigmaScreenHeaderName(line)).toBe("Name");
  });

  it("never bleeds a >20-char trailing separator into the captured name", () => {
    const line = `Screen: Name${" ".repeat(21)}[id]`;
    expect(PRIOR_BOUNDED_PATTERN.exec(line)?.[1]).toBe("Name ");
    expect(parseFigmaScreenHeaderName(line)).toBe("Name");
  });

  it("holds for separators far beyond any quantifier bound (2,000 chars each side)", () => {
    // Demonstrates that "just raise the bound" is not a safe fix for this pattern: this input
    // would reintroduce catastrophic backtracking on `PRIOR_BOUNDED_PATTERN` if its bound were
    // raised to 2,000, because the pattern's worst case scales with bound² × line length. The
    // manual scan has no such term and stays linear regardless of separator width.
    const line = `Screen:${" ".repeat(2_000)}Name${" ".repeat(2_000)}[id]`;
    const start = Date.now();
    const name = parseFigmaScreenHeaderName(line);
    expect(Date.now() - start).toBeLessThan(50);
    expect(name).toBe("Name");
  });

  it("still parses a well-formed header with realistic single-space separators", () => {
    expect(parseFigmaScreenHeaderName("Screen: Vorhaben + Angebote [1:121867]")).toBe(
      "Vorhaben + Angebote",
    );
  });

  it("resolves the LAST bracket pair when the name itself contains bracketed text", () => {
    // Mirrors the original regex's anchored `[^\]]+\]$`: the match must end at the true end of
    // the line, so an earlier "[...]" inside the name is part of the name, not the id bracket.
    expect(parseFigmaScreenHeaderName("Screen: Choose [Filter] Option [42]")).toBe(
      "Choose [Filter] Option",
    );
  });

  it("returns undefined when there is no closing bracket at all", () => {
    expect(parseFigmaScreenHeaderName(`Screen:${" ".repeat(50)}`)).toBeUndefined();
  });

  it('returns undefined when there is no separating whitespace after "Screen:"', () => {
    expect(parseFigmaScreenHeaderName("Screen:Name [id]")).toBeUndefined();
  });

  it("keeps extending the name past a bracket that isn't preceded by whitespace (third remediation pass)", () => {
    // A second adversarial-verification pass on THIS fix (not the bounded-regex one above) found a
    // real regression: the first bracket-open candidate found by a naive forward scan may not be
    // whitespace-separated from the name (e.g. the "[" in "Y[Z" below is glued to "Y"), and the
    // original regex's lazy `(.+?)` would keep extending the name to try the NEXT candidate rather
    // than failing outright. The name can also legitimately contain an unmatched "]".
    expect(parseFigmaScreenHeaderName("Screen: X]Y[Z [id]")).toBe("X]Y[Z");
  });

  it("rejects an id bracket with no content between the brackets", () => {
    // `[^\]]+` requires at least one character inside the id bracket — "Name []" has none.
    expect(parseFigmaScreenHeaderName("Screen: Name []")).toBeUndefined();
  });
});

// Epic #711 / Issue #724 residual: the deterministic-baseline candidate builder is the
// production-default export path when no model is configured (local-first install). Its
// candidate fields must be export-safe — free of bidi/zero-width/control code points — just
// like the model path was hardened in #1038 (parseGeneratedCandidates). Untrusted text enters
// the deterministic builder only via `intent` (derived from source displayLabel, which
// sanitiseLabel does NOT strip these code points from), so the chokepoint lives in
// designTestCaseCandidates.
describe("designTestCaseCandidates — export-safe candidate text", () => {
  it("strips bidi/zero-width/control code points out of every candidate field", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const spoofedLabel = `Login ${ZW}flow user must approve ${RLO}reganam${C1} role ${BOM}grant`;
    const envelope = { ...firstEnvelope(fixture), displayLabel: spoofedLabel };
    const intent = deriveIntent([envelope], regressionDefault);

    // Precondition: the spoofing code points DID survive ingestion-side derivation, so this
    // test exercises the real residual rather than a sanitised input. If this fails the test
    // is no longer guarding the documented gap.
    expect(intent.requirementCandidates.some(hasUnsafeCodePoint)).toBe(true);

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      for (const field of allFieldStrings(candidate)) {
        expect(hasUnsafeCodePoint(field)).toBe(false);
      }
    }

    // The requirement text still flows through (only the spoofing code points are removed),
    // proving the field was exercised and not merely emptied.
    const everyExpectedResult = candidates.flatMap((candidate) => candidate.expectedResults);
    expect(everyExpectedResult.some((line) => line.includes("user must approve reganam"))).toBe(
      true,
    );
  });

  it("collapses a zero-width-spoofed theme into a single canonical tag (no duplicate)", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    // Two tokens that differ only by an inner zero-width space: "login" and "log" + ZW + "in".
    const envelope = { ...firstEnvelope(fixture), displayLabel: `login log${ZW}in` };
    const intent = deriveIntent([envelope], regressionDefault);

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });

    for (const candidate of candidates) {
      const themeTags = candidate.tags.filter((tag) => tag === "theme:login");
      expect(themeTags.length).toBe(1);
      expect(new Set(candidate.tags).size).toBe(candidate.tags.length);
      for (const tag of candidate.tags) {
        expect(hasUnsafeCodePoint(tag)).toBe(false);
      }
    }
  });

  it("drops a fragment that becomes empty after stripping (no blank precondition)", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent: IntentSummary = {
      themes: [],
      requirementCandidates: [`${ZW}${ZW}${ZW}`, "Genuine requirement that must hold"],
      riskHints: [],
      priorityHint: "unknown",
      sourceMode: "body",
      diagnostics: [],
    };

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });

    for (const candidate of candidates) {
      // The all-zero-width fragment strips to "" and is dropped entirely; only the genuine
      // requirement survives. Against the unfixed builder the zero-width fragment is retained,
      // so the length-1 assertion is what makes this mutation-proof.
      expect(candidate.preconditions).toEqual(["Genuine requirement that must hold"]);
      for (const precondition of candidate.preconditions) {
        expect(hasUnsafeCodePoint(precondition)).toBe(false);
      }
    }
  });

  it("does not shift candidate IDs when the source label carries spoofing code points", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const base = firstEnvelope(fixture);
    const cleanIntent = deriveIntent(
      [{ ...base, displayLabel: "Login flow user must approve role grant" }],
      regressionDefault,
    );
    const spoofedIntent = deriveIntent(
      [
        {
          ...base,
          displayLabel: `Login ${ZW}flow user must approve ${RLO}reganam${C1} role ${BOM}grant`,
        },
      ],
      regressionDefault,
    );
    const cleanIds = designTestCaseCandidates({
      runId: fixture.runId,
      intent: cleanIntent,
      atoms: fixture.atoms,
    }).map((candidate) => candidate.id);
    const spoofedIds = designTestCaseCandidates({
      runId: fixture.runId,
      intent: spoofedIntent,
      atoms: fixture.atoms,
    }).map((candidate) => candidate.id);
    expect(spoofedIds).toEqual(cleanIds);
  });
});
