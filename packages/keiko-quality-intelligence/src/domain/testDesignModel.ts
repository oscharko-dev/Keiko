// Quality Intelligence test-design model (Epic #270, Issue #272).
//
// Converts an `IntentSummary` plus the evidence atoms it was derived from
// into a deterministic list of draft `QualityIntelligenceTestCaseCandidate`
// records. NO model calls; NO randomness; ID derivation is content-hash +
// position based, so the same evidence always produces the same candidate IDs
// regardless of the enclosing run id.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/intent-derivation.ts
// (the IR → candidate translation phase). The TI reference produces richer
// UI-oriented candidates with screen/route metadata; our Keiko port stays
// envelope/atom-shaped and policy-driven.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { isKnownPriority, normaliseCandidateText } from "./assertions.js";
import { STRUCTURAL_BASELINE_MARKER } from "./figma/screenIrTestBaseline.js";
import type { IntentSummary } from "./intentDerivation.js";
import type { PolicyProfile } from "./policyProfile.js";
import { regressionDefault } from "./policyProfile.js";

export interface DesignTestCaseCandidatesInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly intent: IntentSummary;
  readonly atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[];
  /**
   * Optional canonical source text by atom id. Evidence atoms intentionally carry only hashes in the
   * public contract, but live ingestion has the canonical text available server-side. Supplying it
   * lets the deterministic baseline produce usable, source-specific tests instead of atom-id stubs.
   */
  readonly atomTextById?: ReadonlyMap<string, string>;
  readonly profile?: PolicyProfile;
}

const compareString = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const stableSortAtoms = (
  atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[],
): readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[] => {
  return [...atoms].sort((left, right) =>
    compareString(left.canonicalHashSha256Hex, right.canonicalHashSha256Hex),
  );
};

const deriveRiskClass = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  profile: PolicyProfile,
): QualityIntelligence.QualityIntelligenceRiskClass => {
  if (atom.kind === "design-fragment") {
    return "visual";
  }
  if (atom.kind === "requirement") {
    return profile.defaultRiskClass === "visual" ? "functional" : profile.defaultRiskClass;
  }
  return profile.defaultRiskClass;
};

const derivePriority = (
  intent: IntentSummary,
  profile: PolicyProfile,
): QualityIntelligence.QualityIntelligencePriority => {
  if (intent.priorityHint !== "unknown" && isKnownPriority(intent.priorityHint)) {
    return intent.priorityHint;
  }
  return profile.defaultPriority;
};

const buildTitle = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
  index: number,
  atomText: string | undefined,
): string => {
  const indexLabel = `#${String(index + 1).padStart(3, "0")}`;
  const sourceSubject = atomText === undefined ? undefined : conciseText(atomText, 90);
  if (sourceSubject !== undefined) {
    if (sourceSubject.startsWith("doc:") || /(?:^|\s)doc:[^\s]+/u.test(sourceSubject)) {
      return `Baseline requirement check ${indexLabel}`;
    }
    return `${indexLabel} Prüfe ${sourceSubject}`;
  }
  const themes = intent.themes.slice(0, 2).join(" / ");
  const subject = themes.length > 0 ? themes : atom.kind;
  return `${indexLabel} ${subject} — ${atom.kind}`;
};

const buildPreconditions = (
  intent: IntentSummary,
  atomText: string | undefined,
): readonly string[] => {
  const preconditions: string[] = [];
  if (atomText !== undefined) {
    const sourceRequirement = conciseText(atomText, 220);
    if (sourceRequirement !== undefined) {
      preconditions.push(`Quellanforderung: ${sourceRequirement}`);
    }
  }
  if (intent.requirementCandidates.length === 0) {
    return Object.freeze(preconditions);
  }
  preconditions.push(...intent.requirementCandidates.slice(0, atomText === undefined ? 3 : 2));
  return Object.freeze(preconditions);
};

const buildSteps = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
  atomText: string | undefined,
): readonly string[] => {
  const steps: string[] = [];
  const theme = intent.themes[0];
  const requirement = atomText === undefined ? undefined : conciseText(atomText, 180);
  if (theme !== undefined) {
    steps.push(`Öffne den ${theme}-Ablauf oder Servicepfad zu dieser Anforderung.`);
  } else {
    steps.push("Öffne den Zielablauf oder Servicepfad zu dieser Anforderung.");
  }
  if (requirement !== undefined) {
    steps.push(`Bereite das Szenario vor, das hier beschrieben ist: ${requirement}`);
  }
  steps.push(
    "Führe die fachliche Aktion, Validierungsregel oder Entscheidungsstrecke aus.",
    `Dokumentiere Ergebnis, persistierten Zustand, Meldungen und Audit-Evidenz für Atom ${atom.id}.`,
  );
  return Object.freeze(steps);
};

const buildExpectedResults = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
  atomText: string | undefined,
): readonly string[] => {
  const results: string[] = [];
  if (atomText !== undefined) {
    const expectedRequirement = conciseText(atomText, 220);
    if (expectedRequirement !== undefined) {
      results.push(`Das beobachtete Verhalten erfüllt: ${expectedRequirement}`);
    }
  } else if (intent.requirementCandidates.length > 0) {
    results.push(`Der Ablauf erfüllt: ${intent.requirementCandidates[0] ?? ""}`);
  } else {
    results.push("Der Ablauf wird ohne Fehler abgeschlossen.");
  }
  results.push(
    "Widersprüchliche Ergebnisse, fehlende Validierung und stiller Datenverlust sind nicht akzeptabel.",
    `Evidenz-Atom ${atom.canonicalHashSha256Hex.slice(0, 12)} bleibt kanonisch.`,
  );
  return Object.freeze(results);
};

/**
 * Stable provenance discriminator carried by every deterministic-baseline candidate.
 *
 * The model-delta builder (`parseGeneratedCandidates`) never emits this tag, so it is a reliable
 * "this is a generic determinism-floor stub, not a judged model candidate" marker — unlike a null
 * `qualityVerdict`, which is also null whenever the judge stage is skipped entirely. Render-layer
 * consumers sort baseline-tagged candidates to the end so judged candidates lead the deliverable;
 * the persisted manifest order stays `[...baseline, ...delta]` (Issue #763 contract). The tag is
 * additive and feeds no candidate id (`sha256(v2<atomHash><index>)`), dedup signature, or manifest
 * hash, so it is determinism-safe.
 */
export const DETERMINISTIC_BASELINE_PROVENANCE_TAG = "source:deterministic-baseline";

const buildTags = (
  intent: IntentSummary,
  riskClass: QualityIntelligence.QualityIntelligenceRiskClass,
): readonly string[] => {
  const tags = new Set<string>();
  for (const theme of intent.themes) {
    tags.add(`theme:${theme}`);
  }
  for (const risk of intent.riskHints) {
    tags.add(`risk-hint:${risk}`);
  }
  tags.add(`risk-class:${riskClass}`);
  tags.add(DETERMINISTIC_BASELINE_PROVENANCE_TAG);
  return Object.freeze(Array.from(tags).sort(compareString));
};

const deriveCandidateIdString = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  index: number,
): string => {
  const payload = ["v2", atom.canonicalHashSha256Hex, String(index)].join("");
  const digest = sha256Hex(payload).slice(0, 32);
  return `qi-candidate-${digest}`;
};

// Sanitise an ordered fragment list for a persisted candidate field: NFKC-normalise,
// strip unsafe bidi / zero-width / C0/C1/DEL code points (via normaliseCandidateText),
// and drop fragments that become empty. Order-preserving, no dedup. The deterministic
// builder receives untrusted text only through `intent` (derived from source display
// labels, which sanitiseLabel does NOT strip bidi/zero-width from), so without this the
// deterministic candidates persist and export those spoofing code points — the
// deterministic-path twin of the model-path chokepoint in parseGeneratedCandidates
// (Epic #711 / Issue #724 residual). Clean fragments are byte-identical (strip is a
// no-op and the fragments are already trimmed), so candidate IDs — derived from
// atomHash/index, never from text — stay stable.
const sanitiseFragmentList = (values: readonly string[]): readonly string[] =>
  Object.freeze(
    values.map((value) => normaliseCandidateText(value)).filter((value) => value.length > 0),
  );

// Sanitise + canonicalise a tag list: strip unsafe code points, drop empties, dedup,
// and sort — preserving the Set+sort semantics of buildTags on the post-strip values so
// a zero-width-spoofed theme cannot smuggle a visually-duplicate tag into the export.
const canonicaliseCandidateTags = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = normaliseCandidateText(value);
    if (cleaned.length > 0) {
      seen.add(cleaned);
    }
  }
  return Object.freeze(Array.from(seen).sort(compareString));
};

const COLLAPSED_WHITESPACE = /\s+/gu;

function conciseText(value: string, maxLength: number): string | undefined {
  const cleaned = normaliseCandidateText(value).replace(COLLAPSED_WHITESPACE, " ").trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function atomTextFor(
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  atomTextById: ReadonlyMap<string, string> | undefined,
): string | undefined {
  return atomTextById === undefined
    ? undefined
    : conciseText(atomTextById.get(String(atom.id)) ?? "", 320);
}

// ─── Figma screen-baseline candidate (clean structural floor) ────────────────────────────────────
//
// A Figma screen atom's canonical text is a Screen-IR STRUCTURAL BASELINE (render / field / control /
// navigation / a11y items), NOT a prose requirement. Run through the generic requirement template
// above, it degenerates into an atom-id/hash-laden stub ("#001 Prüfe <baseline dump> … Öffne den
// <name-suffix>-Ablauf … für Atom <id> … Evidenz-Atom <hash> bleibt kanonisch"). Detect it by its
// stable marker and emit a clean, screen-scoped structural floor test instead. Marker-gated, so every
// NON-figma source kind's deterministic candidate stays byte-identical (no cross-source regression);
// the model path (parseGeneratedCandidates) is unaffected and still produces the per-element tests.

// Single-character whitespace test (no quantifier — called once per scanned character below, so it
// carries none of the multi-character backtracking risk a quantified `\s+`/`\s{1,N}` would).
const isWhitespaceChar = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch);

// Parses a single trimmed "Screen: <name> [<id>]" header line WITHOUT a backtracking regex
// (SonarCloud S8786 root-cause fix, not a bound). The original
// `/^Screen:\s+(.+?)\s+\[[^\]]+\]$/u` had two unbounded `\s+` runs straddling a lazy `(.+?)` that
// also matches whitespace, so a long non-matching line (only whitespace after "Screen:", no
// "[...]") drove severe backtracking. A first pass capped both quantifiers at `{1,20}`, which
// bounds the worst case but changes WHAT gets captured once a separator run exceeds 20 chars
// (confirmed: 21+ separating spaces bleed into the captured name instead of being fully consumed
// by the separator). Raising the bound to make that unreachable does not work either — this
// pattern's worst case scales with the SQUARE of the bound (~bound² × line length: verified
// empirically, bound=20 ⇒ ~23ms, bound=50 ⇒ ~124ms, bound=100 ⇒ ~472ms against a 20,000-char
// adversarial line), so a bound generous enough to never observe the capture-bleed reintroduces
// the same catastrophic slowdown. A manual, single-pass scan removes the ambiguity instead of
// bounding it: consume the mandatory leading whitespace run, then locate the closing "[...]" pair
// exactly the way the regex's anchored `[^\]]+\]$` does (walk back from the line's final "]" to
// the nearest "[" not separated from it by another "]"), then trim the mandatory trailing
// whitespace run off the name from the right only (mirrors the lazy `(.+?)` deferring as much as
// possible to what follows it). Every step is `indexOf`/`lastIndexOf` or a single bounded
// while-loop, so the worst case is LINEAR in the line length for every input shape — there is no
// quantifier left to bound, so there is nothing for a bound to outgrow.
// Consumes "Screen:" plus the mandatory leading `\s+` separator. Returns undefined when the prefix
// or the separator is missing (mirrors the original pattern's `^Screen:\s+`).
function screenHeaderNameStart(line: string): number | undefined {
  const PREFIX = "Screen:";
  if (!line.startsWith(PREFIX)) return undefined;
  const length = line.length;
  let index = PREFIX.length;
  if (!isWhitespaceChar(line[index])) return undefined;
  while (index < length && isWhitespaceChar(line[index])) index += 1;
  return index;
}

// Trims the mandatory whitespace separator immediately before `bracketOpen` off the name — mirrors
// the lazy `(.+?)` deferring as much as possible to what follows it. Returns undefined when there is
// no such separator or the remaining name would be empty.
function screenHeaderNameEnd(
  line: string,
  nameStart: number,
  bracketOpen: number,
): number | undefined {
  let index = bracketOpen;
  while (index > nameStart && isWhitespaceChar(line[index - 1])) index -= 1;
  return index === bracketOpen || index <= nameStart ? undefined : index;
}

// Finds the "[" that opens the closing "[...]" pair anchored at the end of the line: the name's
// character class (`[^\]]+`) forbids "]", so only "[" positions after the last "]"-free run before
// the final "]" are eligible — but that run can itself contain more than one "[" (e.g.
// "X]Y[Z [id]" has candidates at both the "[" in "Y[Z" and the one before "id]"). The original
// regex's lazy `(.+?)\s+` keeps extending the name until SOME candidate is immediately preceded by
// whitespace, so this walks the candidates in the same left-to-right order and returns the first
// one for which `screenHeaderNameEnd` finds a valid separator, instead of stopping at the first "["
// regardless of what precedes it. `[^\]]+` also requires at least one character between "[" and the
// final "]" (an adjacent "[]" has zero-length content and must be rejected, mirroring the `+`).
function screenHeaderBracketOpen(line: string, nameStart: number): number | undefined {
  const length = line.length;
  if (length === 0 || line[length - 1] !== "]") return undefined;
  const priorClose = line.lastIndexOf("]", length - 2);
  let searchFrom = Math.max(nameStart, priorClose + 1);
  while (searchFrom < length - 1) {
    const openIndex = line.indexOf("[", searchFrom);
    if (openIndex === -1 || openIndex >= length - 2) return undefined;
    if (screenHeaderNameEnd(line, nameStart, openIndex) !== undefined) return openIndex;
    searchFrom = openIndex + 1;
  }
  return undefined;
}

// Exported ONLY for direct unit coverage of the capture boundary (`testDesignModel.test.ts`) — not
// re-exported from the package barrel (`src/index.ts`), so this stays an internal implementation
// detail as far as `check:package-surface` and external consumers are concerned.
export function parseFigmaScreenHeaderName(line: string): string | undefined {
  const nameStart = screenHeaderNameStart(line);
  if (nameStart === undefined) return undefined;
  const bracketOpen = screenHeaderBracketOpen(line, nameStart);
  if (bracketOpen === undefined) return undefined;
  const nameEnd = screenHeaderNameEnd(line, nameStart, bracketOpen);
  if (nameEnd === undefined) return undefined;
  return line.slice(nameStart, nameEnd);
}

function figmaScreenNameFromAtomText(rawText: string | undefined): string | undefined {
  if (rawText?.includes(STRUCTURAL_BASELINE_MARKER) !== true) return undefined;
  for (const line of rawText.split("\n")) {
    const name = parseFigmaScreenHeaderName(line.trim())?.trim();
    if (name !== undefined && name.length > 0) return name;
  }
  return undefined;
}

interface CandidateBody {
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
}

function figmaBaselineCandidateBody(index: number, screenName: string): CandidateBody {
  const indexLabel = `#${String(index + 1).padStart(3, "0")}`;
  const subject = conciseText(screenName, 90) ?? screenName;
  return {
    title: `${indexLabel} Strukturelle Baseline-Prüfung: ${subject}`,
    preconditions: [`Die Anwendung ist gestartet.`, `Der Screen "${subject}" ist geöffnet.`],
    steps: [
      `Prüfe, dass der Screen "${subject}" ohne Darstellungsfehler vollständig rendert.`,
      "Prüfe die im Screen-IR-Baseline erfassten strukturellen Prüfpunkte: vorhandene Felder und " +
        "Eingaben, Bedienelemente und ihre Aktionen, Navigationsziele sowie Accessibility-Kriterien " +
        "(Kontrast, Fokusreihenfolge, Zielgröße).",
      "Halte jede Abweichung je strukturellem Prüfpunkt einzeln fest.",
    ],
    expectedResults: [
      `Der Screen "${subject}" rendert korrekt und vollständig.`,
      "Die strukturellen Prüfpunkte (Felder, Bedienelemente, Navigation, Accessibility) des " +
        "Screen-IR-Baselines sind erfüllt.",
      "Es treten keine fehlenden Elemente, Renderfehler oder verletzten Accessibility-Kriterien auf.",
    ],
  };
}

function genericCandidateBody(
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
  index: number,
  atomText: string | undefined,
): CandidateBody {
  return {
    title: buildTitle(atom, intent, index, atomText),
    preconditions: buildPreconditions(intent, atomText),
    steps: buildSteps(atom, intent, atomText),
    expectedResults: buildExpectedResults(atom, intent, atomText),
  };
}

/**
 * Produce deterministic draft candidates from the intent summary + atoms.
 * Returns the empty array when the atom list is empty. Atoms are first
 * sorted by canonical hash so input ordering does not affect IDs.
 *
 * Candidate IDs are derived as
 * `qi-candidate-<32-hex-of-sha256(v2<atomHash><index>)>` — collision-resistant,
 * run-independent, and round-trip-stable for the same evidence.
 */
export const designTestCaseCandidates = (
  input: DesignTestCaseCandidatesInput,
): readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[] => {
  const { runId, intent, atoms, atomTextById } = input;
  const profile = input.profile ?? regressionDefault;
  if (atoms.length === 0) {
    return Object.freeze([] as readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[]);
  }

  const sorted = stableSortAtoms(atoms);
  const priority = derivePriority(intent, profile);

  const candidates: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const atom = sorted[index];
    if (atom === undefined) {
      continue;
    }
    const idString = deriveCandidateIdString(atom, index);
    const id = QualityIntelligence.asQualityIntelligenceTestCaseId(idString);
    const riskClass = deriveRiskClass(atom, profile);
    const atomText = atomTextFor(atom, atomTextById);
    // A Figma screen atom carries a structural baseline, not a prose requirement — give it a clean
    // screen-scoped structural candidate. Detection reads the FULL canonical text (not the truncated
    // `atomText`) so the marker + screen-name header survive the per-title length cap.
    const figmaScreenName = figmaScreenNameFromAtomText(atomTextById?.get(String(atom.id)));
    const body =
      figmaScreenName !== undefined
        ? figmaBaselineCandidateBody(index, figmaScreenName)
        : genericCandidateBody(atom, intent, index, atomText);
    const candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate = {
      id,
      runId,
      derivedFromAtomIds: Object.freeze([atom.id]),
      title: normaliseCandidateText(body.title),
      preconditions: sanitiseFragmentList(body.preconditions),
      steps: sanitiseFragmentList(body.steps),
      expectedResults: sanitiseFragmentList(body.expectedResults),
      priority,
      riskClass,
      tags: canonicaliseCandidateTags(buildTags(intent, riskClass)),
      status: "proposed",
    };
    candidates.push(Object.freeze(candidate));
  }
  return Object.freeze(candidates);
};
