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

// Strip a single ```json … ``` or ``` … ``` fence if the whole payload is fenced.
const stripCodeFence = (raw: string): string => {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(raw.trim());
  return fence?.[1] ?? raw;
};

interface StringScan {
  readonly inString: boolean;
  readonly escaped: boolean;
}

// Advance the in-string scanner one character (honours backslash escapes).
const consumeStringChar = (ch: string, escaped: boolean): StringScan => {
  if (escaped) return { inString: true, escaped: false };
  if (ch === "\\") return { inString: true, escaped: true };
  if (ch === '"') return { inString: false, escaped: false };
  return { inString: true, escaped: false };
};

// Scan for the first balanced JSON value (object or array) honouring string literals + escapes,
// so a `}` inside a quoted step does not terminate the scan early.
const extractFirstJsonValue = (text: string): string | undefined => {
  const open = firstOpenIndex(text);
  if (open === -1) return undefined;
  const openChar = text[open];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let scan: StringScan = { inString: false, escaped: false };
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (scan.inString) {
      scan = consumeStringChar(ch, scan.escaped);
      continue;
    }
    if (ch === '"') scan = { inString: true, escaped: false };
    else if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return undefined;
};

const firstOpenIndex = (text: string): number => {
  const obj = text.indexOf("{");
  const arr = text.indexOf("[");
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
};

const parseJsonLoose = (raw: string): unknown => {
  const stripped = stripCodeFence(raw);
  const slice = extractFirstJsonValue(stripped);
  if (slice === undefined) return undefined;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
};

// Accept either a bare array of test cases or the documented `{ testCases: [...] }` wrapper.
const toRawItems = (parsed: unknown): readonly unknown[] => {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.testCases)) return parsed.testCases;
  return [];
};

const toStringList = (value: unknown): readonly string[] => {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/u)
      : [];
  const out: string[] = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const text = normaliseCandidateText(entry);
    if (text.length > 0) out.push(text);
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

const deriveCandidateId = (runId: RunId, index: number, title: string): string => {
  const digest = sha256Hex(`qi-cand-v1|${String(runId)}|${String(index)}|${title}`).slice(0, 32);
  return `qi-candidate-${digest}`;
};

const buildCandidate = (
  raw: Record<string, unknown>,
  index: number,
  input: ParseGeneratedCandidatesInput,
  profile: PolicyProfile,
): Candidate | undefined => {
  const title = normaliseCandidateText(typeof raw.title === "string" ? raw.title : "");
  const steps = toStringList(raw.steps);
  if (title.length === 0 || steps.length === 0) return undefined;
  const expectedResults = toStringList(raw.expectedResults);
  const tags = toStringList(raw.tags);
  return Object.freeze<Candidate>({
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(
      deriveCandidateId(input.runId, index, title),
    ),
    runId: input.runId,
    derivedFromAtomIds: resolveDerivedAtomIds(raw.derivedFromEvidenceIndexes, input.atomIds, index),
    title,
    preconditions: toStringList(raw.preconditions),
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
