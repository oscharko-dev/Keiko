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
  for (let i = 0; i < text.length; i += 1) {
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

const clampPriority = (value: unknown, profile: PolicyProfile): Priority =>
  typeof value === "string" && PRIORITIES.has(value)
    ? (value as Priority)
    : profile.defaultPriority;

const clampRiskClass = (value: unknown, profile: PolicyProfile): RiskClass =>
  typeof value === "string" && RISK_CLASSES.has(value)
    ? (value as RiskClass)
    : profile.defaultRiskClass;

// Map the model's 1-based evidence indexes to atom IDs. Out-of-range / non-integer entries are
// dropped. When the model supplied none, fall back to a positional atom so every candidate keeps
// at least one provenance link (traceability invariant) without faking full coverage.
const resolveDerivedAtomIds = (
  value: unknown,
  atomIds: readonly AtomId[],
  positionalIndex: number,
): readonly AtomId[] => {
  const ids: AtomId[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const idx = typeof entry === "number" ? Math.trunc(entry) : Number.NaN;
      const atom = Number.isInteger(idx) ? atomIds[idx - 1] : undefined;
      if (atom !== undefined && !ids.includes(atom)) ids.push(atom);
    }
  }
  if (ids.length > 0) return Object.freeze(ids);
  if (atomIds.length === 0) return Object.freeze([]);
  const fallback = atomIds[positionalIndex % atomIds.length];
  return fallback === undefined ? Object.freeze([]) : Object.freeze([fallback]);
};

const deriveCandidateId = (
  index: number,
  title: string,
  derivedFromAtomIds: readonly AtomId[],
): string => {
  const atomRefs = derivedFromAtomIds.map(String).join("|");
  const digest = sha256Hex(`qi-cand-v2|${String(index)}|${title}|${atomRefs}`).slice(0, 32);
  return `qi-candidate-${digest}`;
};

const buildCandidate = (
  raw: Record<string, unknown>,
  index: number,
  input: ParseGeneratedCandidatesInput,
  profile: PolicyProfile,
): Candidate | undefined => {
  const title = toBoundedText(raw.title, GENERATED_CANDIDATE_TITLE_MAX_CHARS);
  const steps = stepList(raw.steps);
  if (title.length === 0 || steps.length === 0) return undefined;
  const expectedResults = textList(
    raw.expectedResults,
    GENERATED_CANDIDATE_EXPECTED_RESULT_MAX_ITEMS,
  );
  const tags = toStringList(raw.tags, {
    maxItems: GENERATED_CANDIDATE_TAG_MAX_ITEMS,
    maxChars: GENERATED_CANDIDATE_TAG_MAX_CHARS,
  });
  const derivedFromAtomIds = resolveDerivedAtomIds(
    raw.derivedFromEvidenceIndexes,
    input.atomIds,
    index,
  );
  return Object.freeze<Candidate>({
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(
      deriveCandidateId(index, title, derivedFromAtomIds),
    ),
    runId: input.runId,
    derivedFromAtomIds,
    title,
    preconditions: textList(raw.preconditions, GENERATED_CANDIDATE_PRECONDITION_MAX_ITEMS),
    steps,
    expectedResults:
      expectedResults.length > 0
        ? expectedResults
        : Object.freeze(["The behaviour matches the cited evidence."]),
    priority: clampPriority(raw.priority, profile),
    riskClass: clampRiskClass(raw.riskClass, profile),
    tags,
    status: "proposed",
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
): ParseGeneratedCandidatesResult => {
  const profile = input.profile ?? regressionDefault;
  const parsed = parseJsonLoose(typeof rawText === "string" ? rawText : "");
  if (parsed === undefined) {
    return { candidates: Object.freeze([]), recovered: false, skipped: 0 };
  }
  const rawItems = toRawItems(parsed);
  const cap = Math.max(0, Math.trunc(input.maxCandidates));
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (let i = 0; i < rawItems.length && candidates.length < cap; i += 1) {
    const item = rawItems[i];
    if (!isObject(item)) {
      skipped += 1;
      continue;
    }
    const candidate = buildCandidate(item, i, input, profile);
    if (candidate === undefined) skipped += 1;
    else candidates.push(candidate);
  }
  return { candidates: Object.freeze(candidates), recovered: true, skipped };
};
