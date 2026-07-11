// Quality Intelligence — model-output → candidate parser (Epic #270, Issue #272/#279).
//
// Pure, deterministic recovery of `QualityIntelligenceTestCaseCandidate` records from the raw
// text a model returns. Robust to: code fences, a reasoning preamble before the JSON, a bare
// array vs the `{ testCases: [...] }` wrapper, and missing / out-of-range fields. NO IO, NO
// model call, NO randomness — IDs are content-hash derived so the same model output yields the
// same candidate IDs (round-trip stable, mutation-detectable).

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseCandidateText } from "../domain/assertions.js";
import { assertCandidateCount, MAX_CANDIDATES_PER_RUN } from "../hardening/oversizeGuards.js";
import type { PolicyProfile } from "../domain/policyProfile.js";
import { regressionDefault } from "../domain/policyProfile.js";
import {
  GENERATED_CANDIDATE_EXPECTED_RESULT_MAX_ITEMS,
  GENERATED_CANDIDATE_PRECONDITION_MAX_ITEMS,
  GENERATED_CANDIDATE_STEP_MAX_ITEMS,
  GENERATED_CANDIDATE_TAG_MAX_CHARS,
  GENERATED_CANDIDATE_TAG_MAX_ITEMS,
  GENERATED_CANDIDATE_TEXT_ITEM_MAX_CHARS,
  GENERATED_CANDIDATE_TITLE_MAX_CHARS,
} from "./candidateBounds.js";

type Candidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;
type RunId = QualityIntelligence.QualityIntelligenceRunId;
type AtomId = QualityIntelligence.QualityIntelligenceEvidenceAtomId;
type Priority = QualityIntelligence.QualityIntelligencePriority;
type RiskClass = QualityIntelligence.QualityIntelligenceRiskClass;

const PRIORITIES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_PRIORITIES,
);
const RISK_CLASSES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_RISK_CLASSES,
);

export const MAX_GENERATED_CANDIDATE_OUTPUT_CHARS = 1_000_000;
export const MAX_JSON_RECOVERY_ATTEMPTS = 32;
export const MAX_DERIVED_ATOM_IDS_PER_CANDIDATE = 8;

export const GENERATED_CANDIDATE_TAG_PROVENANCE_UNVERIFIED = "provenance-unverified";
export const GENERATED_CANDIDATE_TAG_EVIDENCE_INDEX_INVALID = "evidence-index-invalid";
export const GENERATED_CANDIDATE_TAG_EVIDENCE_OVER_CITED = "evidence-over-cited";
export const GENERATED_CANDIDATE_TAG_PRIORITY_DEFAULTED = "priority-defaulted";
export const GENERATED_CANDIDATE_TAG_RISK_DEFAULTED = "risk-defaulted";
export const GENERATED_CANDIDATE_TAG_EXPECTED_RESULT_AUTOFILLED = "expected-result-autofilled";
export const GENERATED_CANDIDATE_TAG_EXPECTED_RESULT_PLACEHOLDER = "expected-result-placeholder";

const ENGLISH_FALLBACK_EXPECTED_RESULT = "The behaviour matches the cited evidence.";
const GERMAN_FALLBACK_EXPECTED_RESULT = "Das Verhalten entspricht der zitierten Evidenz.";

const GERMAN_LANGUAGE_SIGNAL_PATTERN =
  /[äöüÄÖÜß]|\b(?:anforderung|benutzer|betrag|das|dem|den|der|des|die|einzahlung|evidenz|freigabe|konto|kunde|kundin|muss|nicht|oder|pruefe|prüfe|regel|soll|ueberweisung|überweisung|und|verhalten|zahlung)\b/iu;

const VAGUE_EXPECTED_RESULT_PATTERN =
  /\b(?:all requirements are satisfied|behaviou?r matches(?: the)? cited evidence|expected result|expected outcome|matches the cited evidence|works as expected|das erwartete ergebnis tritt ein|das verhalten entspricht(?: der)? zitierten evidenz|funktioniert wie erwartet|verhalten wie erwartet)\b/iu;

export interface ParseGeneratedCandidatesInput {
  readonly runId: RunId;
  /** Atom IDs in the SAME order they were numbered (1-based) in the prompt evidence block. */
  readonly atomIds: readonly AtomId[];
  readonly profile?: PolicyProfile;
  readonly maxCandidates: number;
}

export interface ParseGeneratedCandidatesResult {
  readonly candidates: readonly Candidate[];
  /** True when no JSON object/array could be recovered from the model text at all. */
  readonly recovered: boolean;
  /** Count of raw items skipped because they lacked a usable title or steps. */
  readonly skipped: number;
  /** Count of raw items not inspected because maxCandidates had already been reached. */
  readonly overCapSkipped: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CANDIDATE_ARRAY_KEYS = ["testCases", "test_cases", "tests", "cases"] as const;

// Strip a single ```json … ``` or ``` … ``` fence if the whole payload is fenced.
const stripCodeFence = (raw: string): string => {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(raw.trim());
  return fence?.[1] ?? raw;
};

interface StringScan {
  readonly inString: boolean;
  readonly escaped: boolean;
}

interface JsonBalanceStep {
  readonly depth: number;
  readonly scan: StringScan;
  readonly closed: boolean;
}

// Advance the in-string scanner one character (honours backslash escapes).
const consumeStringChar = (ch: string, escaped: boolean): StringScan => {
  if (escaped) return { inString: true, escaped: false };
  if (ch === "\\") return { inString: true, escaped: true };
  if (ch === '"') return { inString: false, escaped: false };
  return { inString: true, escaped: false };
};

const isJsonOpen = (ch: string | undefined): ch is "{" | "[" => ch === "{" || ch === "[";

const advanceJsonBalance = (
  ch: string,
  openChar: "{" | "[",
  closeChar: "}" | "]",
  scan: StringScan,
  depth: number,
): JsonBalanceStep => {
  if (scan.inString) {
    return { depth, scan: consumeStringChar(ch, scan.escaped), closed: false };
  }
  if (ch === '"') return { depth, scan: { inString: true, escaped: false }, closed: false };
  if (ch === openChar) return { depth: depth + 1, scan, closed: false };
  if (ch !== closeChar) return { depth, scan, closed: false };
  const nextDepth = depth - 1;
  return { depth: nextDepth, scan, closed: nextDepth === 0 };
};

// Scan a balanced JSON value (object or array) at `open`, honouring string literals + escapes, so a
// `}` inside a quoted step does not terminate the scan early.
const extractJsonValueAt = (text: string, open: number): string | undefined => {
  const openChar = text[open];
  if (!isJsonOpen(openChar)) return undefined;
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let scan: StringScan = { inString: false, escaped: false };
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const next = advanceJsonBalance(ch, openChar, closeChar, scan, depth);
    depth = next.depth;
    scan = next.scan;
    if (next.closed) return text.slice(open, i + 1);
  }
  return undefined;
};

const hasCandidateContainer = (parsed: unknown): boolean =>
  Array.isArray(parsed) ||
  (isObject(parsed) && CANDIDATE_ARRAY_KEYS.some((key) => Array.isArray(parsed[key])));

// Accept either a bare array of test cases, the documented `{ testCases: [...] }` wrapper, or a
// small set of common chat-model aliases used when response-format schemas are unavailable.
const toRawItems = (parsed: unknown): readonly unknown[] => {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed)) {
    for (const key of CANDIDATE_ARRAY_KEYS) {
      const value = parsed[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
};

const candidateContainerItemCount = (parsed: unknown): number =>
  hasCandidateContainer(parsed) ? toRawItems(parsed).length : -1;

interface ParsedJsonSlice {
  readonly parsed: unknown;
  readonly itemCount: number;
}

const parseJsonSliceAt = (text: string, index: number): ParsedJsonSlice | undefined => {
  if (!isJsonOpen(text[index])) return undefined;
  const slice = extractJsonValueAt(text, index);
  if (slice === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(slice);
    return { parsed, itemCount: candidateContainerItemCount(parsed) };
  } catch {
    return undefined;
  }
};

// Parse the first useful JSON candidate payload. If a chat model emits an invalid bracket fragment
// before the real JSON, keep scanning; if it emits only a wrong-shape JSON value, preserve the old
// `recovered:true, candidates:[]` behaviour by returning the first successfully parsed value.
const parseFirstUsefulJsonValue = (text: string): unknown => {
  let firstParsed: unknown;
  let firstEmptyCandidateContainer: unknown;
  let attempts = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!isJsonOpen(text[i])) continue;
    attempts += 1;
    if (attempts > MAX_JSON_RECOVERY_ATTEMPTS) break;
    const parsedSlice = parseJsonSliceAt(text, i);
    if (parsedSlice === undefined) continue;
    const { parsed, itemCount } = parsedSlice;
    if (firstParsed === undefined) firstParsed = parsed;
    if (itemCount > 0) return parsed;
    if (itemCount === 0 && firstEmptyCandidateContainer === undefined) {
      firstEmptyCandidateContainer = parsed;
    }
  }
  return firstEmptyCandidateContainer ?? firstParsed;
};

const parseJsonLoose = (raw: string): unknown => {
  const stripped = stripCodeFence(raw);
  return parseFirstUsefulJsonValue(stripped);
};

const truncateText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;

interface StringListLimits {
  readonly maxItems: number;
  readonly maxChars: number;
}

const toBoundedText = (value: unknown, maxChars: number): string =>
  truncateText(normaliseCandidateText(typeof value === "string" ? value : ""), maxChars);

const toRawStringListSource = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/\r?\n/u);
  return [];
};

const toStringList = (value: unknown, limits: StringListLimits): readonly string[] => {
  const out: string[] = [];
  for (const entry of toRawStringListSource(value)) {
    if (out.length >= limits.maxItems) break;
    if (typeof entry !== "string") continue;
    const text = toBoundedText(entry, limits.maxChars);
    if (text.length > 0) out.push(text);
  }
  return out;
};

const textList = (value: unknown, maxItems: number): readonly string[] =>
  toStringList(value, {
    maxItems,
    maxChars: GENERATED_CANDIDATE_TEXT_ITEM_MAX_CHARS,
  });

const canonicalStepText = (value: string): string =>
  normaliseCandidateText(value).toLowerCase().replace(/\s+/gu, " ").trim();

const stepList = (value: unknown): readonly string[] => {
  const out: string[] = [];
  let previousCanonical = "";
  for (const entry of toRawStringListSource(value)) {
    if (typeof entry !== "string") continue;
    const text = toBoundedText(entry, GENERATED_CANDIDATE_TEXT_ITEM_MAX_CHARS);
    if (text.length === 0) continue;
    const canonical = canonicalStepText(text);
    if (canonical === previousCanonical) continue;
    out.push(text);
    previousCanonical = canonical;
    if (out.length >= GENERATED_CANDIDATE_STEP_MAX_ITEMS) break;
  }
  return out;
};

interface ParsedEnumField<T> {
  readonly value: T;
  readonly defaulted: boolean;
}

const parsePriority = (value: unknown, profile: PolicyProfile): ParsedEnumField<Priority> =>
  typeof value === "string" && PRIORITIES.has(value)
    ? { value: value as Priority, defaulted: false }
    : { value: profile.defaultPriority, defaulted: true };

const parseRiskClass = (value: unknown, profile: PolicyProfile): ParsedEnumField<RiskClass> =>
  typeof value === "string" && RISK_CLASSES.has(value)
    ? { value: value as RiskClass, defaulted: false }
    : { value: profile.defaultRiskClass, defaulted: true };

interface EvidenceIndexResolution {
  readonly ids: readonly AtomId[];
  readonly hasInvalidIndex: boolean;
  readonly overCited: boolean;
  readonly provenanceUnverified: boolean;
}

// Map the model's 1-based evidence indexes to atom IDs. Out-of-range / non-integer entries are
// dropped and surfaced as diagnostics. The parser must not synthesize a positional provenance link:
// a missing or invalid citation is explicitly unverified.
const resolveDerivedAtomIds = (
  value: unknown,
  atomIds: readonly AtomId[],
): EvidenceIndexResolution => {
  const ids: AtomId[] = [];
  let hasInvalidIndex = false;
  let overCited = false;
  if (!Array.isArray(value)) {
    return {
      ids: Object.freeze([]),
      hasInvalidIndex: false,
      overCited: false,
      provenanceUnverified: true,
    };
  }
  for (const entry of value) {
    const idx = typeof entry === "number" && Number.isInteger(entry) ? entry : Number.NaN;
    const atom = Number.isInteger(idx) ? atomIds[idx - 1] : undefined;
    if (atom === undefined) {
      hasInvalidIndex = true;
      continue;
    }
    if (ids.includes(atom)) continue;
    if (ids.length >= MAX_DERIVED_ATOM_IDS_PER_CANDIDATE) {
      overCited = true;
      continue;
    }
    ids.push(atom);
  }
  return {
    ids: Object.freeze(ids),
    hasInvalidIndex,
    overCited,
    provenanceUnverified: ids.length === 0,
  };
};

const deriveCandidateId = (
  title: string,
  derivedFromAtomIds: readonly AtomId[],
  preconditions: readonly string[],
  steps: readonly string[],
  expectedResults: readonly string[],
): string => {
  const atomRefs = [...derivedFromAtomIds].map(String).sort().join("|");
  const bodyDigest = sha256Hex(
    [...preconditions, ...steps, ...expectedResults]
      .map((part) => normaliseCandidateText(part))
      .join("\n"),
  ).slice(0, 32);
  const digest = sha256Hex(
    `qi-cand-v3|${normaliseCandidateText(title)}|${atomRefs}|${bodyDigest}`,
  ).slice(0, 32);
  return `qi-candidate-${digest}`;
};

const isProbablyGermanCandidate = (parts: readonly string[]): boolean =>
  GERMAN_LANGUAGE_SIGNAL_PATTERN.test(parts.join(" "));

const fallbackExpectedResult = (parts: readonly string[]): string =>
  isProbablyGermanCandidate(parts)
    ? GERMAN_FALLBACK_EXPECTED_RESULT
    : ENGLISH_FALLBACK_EXPECTED_RESULT;

const hasVagueExpectedResult = (expectedResults: readonly string[]): boolean =>
  expectedResults.some((text) => VAGUE_EXPECTED_RESULT_PATTERN.test(normaliseCandidateText(text)));

const mergeCandidateTags = (
  modelTags: readonly string[],
  diagnosticTags: readonly string[],
): readonly string[] => {
  const out: string[] = [];
  const add = (tag: string): void => {
    if (out.length >= GENERATED_CANDIDATE_TAG_MAX_ITEMS) return;
    const bounded = truncateText(tag, GENERATED_CANDIDATE_TAG_MAX_CHARS);
    if (bounded.length > 0 && !out.includes(bounded)) out.push(bounded);
  };
  for (const tag of diagnosticTags) add(tag);
  for (const tag of modelTags) add(tag);
  return Object.freeze(out);
};

// eslint-disable-next-line max-lines-per-function
const buildCandidate = (
  raw: Record<string, unknown>,
  input: ParseGeneratedCandidatesInput,
  profile: PolicyProfile,
  // eslint-disable-next-line complexity
): Candidate | undefined => {
  const title = toBoundedText(raw.title, GENERATED_CANDIDATE_TITLE_MAX_CHARS);
  const steps = stepList(raw.steps);
  if (title.length === 0 || steps.length === 0) return undefined;
  const preconditions = textList(raw.preconditions, GENERATED_CANDIDATE_PRECONDITION_MAX_ITEMS);
  const parsedExpectedResults = textList(
    raw.expectedResults,
    GENERATED_CANDIDATE_EXPECTED_RESULT_MAX_ITEMS,
  );
  const expectedResultsAutofilled = parsedExpectedResults.length === 0;
  const expectedResults = expectedResultsAutofilled
    ? Object.freeze([fallbackExpectedResult([title, ...preconditions, ...steps])])
    : parsedExpectedResults;
  const modelTags = toStringList(raw.tags, {
    maxItems: GENERATED_CANDIDATE_TAG_MAX_ITEMS,
    maxChars: GENERATED_CANDIDATE_TAG_MAX_CHARS,
  });
  const evidence = resolveDerivedAtomIds(raw.derivedFromEvidenceIndexes, input.atomIds);
  const priority = parsePriority(raw.priority, profile);
  const riskClass = parseRiskClass(raw.riskClass, profile);
  const diagnosticTags: string[] = [];
  if (evidence.provenanceUnverified) {
    diagnosticTags.push(GENERATED_CANDIDATE_TAG_PROVENANCE_UNVERIFIED);
  }
  if (evidence.hasInvalidIndex) {
    diagnosticTags.push(GENERATED_CANDIDATE_TAG_EVIDENCE_INDEX_INVALID);
  }
  if (evidence.overCited) {
    diagnosticTags.push(GENERATED_CANDIDATE_TAG_EVIDENCE_OVER_CITED);
  }
  if (priority.defaulted) diagnosticTags.push(GENERATED_CANDIDATE_TAG_PRIORITY_DEFAULTED);
  if (riskClass.defaulted) diagnosticTags.push(GENERATED_CANDIDATE_TAG_RISK_DEFAULTED);
  if (expectedResultsAutofilled) {
    diagnosticTags.push(GENERATED_CANDIDATE_TAG_EXPECTED_RESULT_AUTOFILLED);
  }
  if (expectedResultsAutofilled || hasVagueExpectedResult(expectedResults)) {
    diagnosticTags.push(GENERATED_CANDIDATE_TAG_EXPECTED_RESULT_PLACEHOLDER);
  }
  const tags = mergeCandidateTags(modelTags, diagnosticTags);
  return Object.freeze<Candidate>({
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(
      deriveCandidateId(title, evidence.ids, preconditions, steps, expectedResults),
    ),
    runId: input.runId,
    derivedFromAtomIds: evidence.ids,
    title,
    preconditions,
    steps,
    expectedResults,
    priority: priority.value,
    riskClass: riskClass.value,
    tags,
    status: diagnosticTags.length > 0 ? "needs-review" : "proposed",
  });
};

/**
 * Parse raw model output into validated candidates. Returns `recovered: false` when no JSON value
 * could be located, so the orchestrator can fail the run with a clear, non-secret reason instead
 * of silently emitting zero candidates.
 */
export const parseGeneratedCandidates = (
  rawText: string,
  input: ParseGeneratedCandidatesInput,
  // eslint-disable-next-line complexity
): ParseGeneratedCandidatesResult => {
  const profile = input.profile ?? regressionDefault;
  const boundedRawText =
    typeof rawText === "string" && rawText.length <= MAX_GENERATED_CANDIDATE_OUTPUT_CHARS
      ? rawText
      : "";
  const parsed = parseJsonLoose(boundedRawText);
  if (parsed === undefined) {
    return { candidates: Object.freeze([]), recovered: false, skipped: 0, overCapSkipped: 0 };
  }
  const rawItems = toRawItems(parsed);
  const candidateCount = assertCandidateCount(rawItems.length);
  const boundedRawItems = candidateCount.ok ? rawItems : rawItems.slice(0, MAX_CANDIDATES_PER_RUN);
  const requestedCap = Number.isFinite(input.maxCandidates)
    ? Math.max(0, Math.trunc(input.maxCandidates))
    : 0;
  const cap = Math.min(requestedCap, MAX_CANDIDATES_PER_RUN);
  const candidates: Candidate[] = [];
  let skipped = 0;
  let inspected = 0;
  for (let i = 0; i < boundedRawItems.length && candidates.length < cap; i += 1) {
    inspected += 1;
    const item = boundedRawItems[i];
    if (!isObject(item)) {
      skipped += 1;
      continue;
    }
    const candidate = buildCandidate(item, input, profile);
    if (candidate === undefined) skipped += 1;
    else candidates.push(candidate);
  }
  return {
    candidates: Object.freeze(candidates),
    recovered: true,
    skipped,
    overCapSkipped: Math.max(0, rawItems.length - inspected),
  };
};
