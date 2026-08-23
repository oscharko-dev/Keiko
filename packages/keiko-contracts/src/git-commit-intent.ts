// Deterministic commit-INTENT composition contracts (Issue #475, Epic #470). Ownership: the pure,
// deterministic heuristics that turn a content-free staged-change SUMMARY (counts, distinct top-level
// area tokens, a touches-tests flag) plus an optional message draft into quality warnings and
// scaffolding suggestions (a suggested type/scope and a `type(scope): ` subject prefix). The
// suggestions are DETERMINISTIC rules — never a model call (ADR-0062 §5). The summary is content-free
// by construction: it carries counts, a bounded list of low-sensitivity structural area tokens, and a
// boolean; it never carries raw paths, diff content, or file contents.
//
// Disjoint from git-commit-policy.ts (the message-policy validator that gates the commit) and from
// git-delivery.ts (the action model). The change SUMMARY is produced in keiko-tools from the staged
// pathspec; this leaf only defines its shape and the pure analyzer over it.
//
// Leaf-package rules (ADR-0019, ADR-0062): pure types, frozen const tables, and pure functions only.
// No IO, no clock, no crypto, no randomness. Relative imports end in ".js".

import { validateGitCommitMessage, type GitCommitMessagePolicy } from "./git-commit-policy.js";

// Pinned schema version. A breaking change adds a NEW literal member; this one is never mutated.
export const GIT_COMMIT_INTENT_SCHEMA_VERSION = "1" as const;

// Default ceiling above which a changeset is flagged "large-change". Overridable per call.
export const DEFAULT_LARGE_CHANGE_THRESHOLD = 20;

// ─── Change summary (content-free, produced in tools) ─────────────────────────────────────────────
// `areas` are distinct top-level path segments (low-sensitivity structural tokens), bounded by the
// producer. `areaCount` is the count of distinct areas (it may exceed `areas.length` when the
// producer caps the listed areas, so the analyzer reads `areaCount` for the mixed-scope decision).

export interface GitCommitChangeSummary {
  readonly stagedFileCount: number;
  readonly areaCount: number;
  readonly areas: readonly string[];
  readonly touchesTests: boolean;
}

// ─── Quality-warning vocabulary ───────────────────────────────────────────────────────────────────

export type GitCommitQualityWarningCode =
  "mixed-scope" | "wip-marker" | "large-change" | "empty-body" | "non-conventional-subject";

export const GIT_COMMIT_QUALITY_WARNING_CODES: readonly GitCommitQualityWarningCode[] = [
  "mixed-scope",
  "wip-marker",
  "large-change",
  "empty-body",
  "non-conventional-subject",
] as const;

// ─── Analysis result ──────────────────────────────────────────────────────────────────────────────

export interface GitCommitIntentAnalysis {
  readonly warnings: readonly GitCommitQualityWarningCode[];
  readonly mixedScope: boolean;
  readonly isWip: boolean;
  readonly suggestedType?: string | undefined;
  readonly suggestedScope?: string | undefined;
  readonly suggestedSubjectPrefix?: string | undefined;
}

export interface GitCommitIntentInput {
  readonly summary: GitCommitChangeSummary;
  readonly message?: string | undefined;
  readonly largeChangeThreshold?: number | undefined;
}

// ─── Private predicate helpers ────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

// ─── Message structure ──────────────────────────────────────────────────────────────────────────
// Subject = first line; the body is the remaining non-blank lines. WIP detection and the
// conventional-prefix check read the subject only; the empty-body check reads the body.

const WIP_RE = /\bwip\b/i;
const CONVENTIONAL_PREFIX_RE = /^[a-zA-Z]+(\([^()]*\))?(!)?: .+$/;

interface MessageFacts {
  readonly hasMessage: boolean;
  readonly subject: string;
  readonly hasBody: boolean;
}

function messageFacts(message: string | undefined): MessageFacts {
  if (message === undefined) {
    return { hasMessage: false, subject: "", hasBody: false };
  }
  const lines = message.split("\n");
  const subject = (lines[0] ?? "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { hasMessage: true, subject, hasBody: body.length > 0 };
}

// ─── Suggestion heuristics ────────────────────────────────────────────────────────────────────────
// Deterministic, conservative: a single dominant area becomes the scope; a tests-only single-area
// change suggests `test`, a docs-only single-area change suggests `docs`; otherwise no type is
// suggested. A subject prefix is scaffolded only when BOTH a type and a scope are derivable.

function dominantScope(summary: GitCommitChangeSummary): string | undefined {
  if (summary.areaCount !== 1) {
    return undefined;
  }
  const only = summary.areas[0];
  return only !== undefined && only.length > 0 ? only : undefined;
}

function suggestedTypeFor(
  summary: GitCommitChangeSummary,
  scope: string | undefined,
): string | undefined {
  if (scope === undefined) {
    return undefined;
  }
  if (summary.touchesTests) {
    return "test";
  }
  if (scope === "docs") {
    return "docs";
  }
  return undefined;
}

// ─── Warning derivation ─────────────────────────────────────────────────────────────────────────

interface WarningSignals {
  readonly mixedScope: boolean;
  readonly isWip: boolean;
  readonly large: boolean;
  readonly emptyBody: boolean;
  readonly nonConventionalSubject: boolean;
}

function deriveSignals(input: GitCommitIntentInput, facts: MessageFacts): WarningSignals {
  const threshold = input.largeChangeThreshold ?? DEFAULT_LARGE_CHANGE_THRESHOLD;
  const nonConventionalSubject = facts.hasMessage && !CONVENTIONAL_PREFIX_RE.test(facts.subject);
  return {
    mixedScope: input.summary.areaCount > 1,
    isWip: facts.hasMessage && WIP_RE.test(facts.subject),
    large: input.summary.stagedFileCount > threshold,
    emptyBody: facts.hasMessage && !facts.hasBody,
    nonConventionalSubject,
  };
}

function collectWarnings(signals: WarningSignals): readonly GitCommitQualityWarningCode[] {
  const warnings: GitCommitQualityWarningCode[] = [];
  if (signals.mixedScope) {
    warnings.push("mixed-scope");
  }
  if (signals.isWip) {
    warnings.push("wip-marker");
  }
  if (signals.large) {
    warnings.push("large-change");
  }
  if (signals.emptyBody) {
    warnings.push("empty-body");
  }
  if (signals.nonConventionalSubject) {
    warnings.push("non-conventional-subject");
  }
  return warnings;
}

// ─── Analyzer (PURE, deterministic) ───────────────────────────────────────────────────────────────

export function analyzeGitCommitIntent(input: GitCommitIntentInput): GitCommitIntentAnalysis {
  const facts = messageFacts(input.message);
  const signals = deriveSignals(input, facts);
  const scope = dominantScope(input.summary);
  const type = suggestedTypeFor(input.summary, scope);
  const base: GitCommitIntentAnalysis = {
    warnings: collectWarnings(signals),
    mixedScope: signals.mixedScope,
    isWip: signals.isWip,
  };
  return {
    ...base,
    ...(type !== undefined ? { suggestedType: type } : {}),
    ...(scope !== undefined ? { suggestedScope: scope } : {}),
    ...(type !== undefined && scope !== undefined
      ? { suggestedSubjectPrefix: `${type}(${scope}): ` }
      : {}),
  };
}

// ─── Commit-message drafting ───────────────────────────────────────────────────────────────────
// The draft intentionally describes only the fact of the staged change. It never guesses a semantic
// verb from source content, paths, or a model response. A suggestion is returned only when it already
// satisfies the server-resolved policy; requirements that need user-specific information (for example
// an issue key or DCO sign-off) leave the draft unavailable for the user to complete deliberately.

const GENERIC_DRAFT_SUBJECT = "Update staged changes";

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function areaDescription(summary: GitCommitChangeSummary): string {
  if (summary.areaCount === 0) return "";
  const areaCount = summary.areaCount.toString();
  const areaNoun = plural(summary.areaCount, "area", "areas");
  if (summary.areas.length === 0) return ` across ${areaCount} ${areaNoun}`;
  if (summary.areaCount === 1) return ` in ${summary.areas[0] ?? "the selected area"}`;
  const listedAreas = summary.areas.join(", ");
  if (summary.areaCount === summary.areas.length) return ` across ${listedAreas}`;
  return ` across ${areaCount} ${areaNoun}, including ${listedAreas}`;
}

function draftBody(summary: GitCommitChangeSummary): string {
  const stagedFileCount = summary.stagedFileCount.toString();
  const fileNoun = plural(summary.stagedFileCount, "file", "files");
  const lines = [
    `Update ${stagedFileCount} staged ${fileNoun}${areaDescription(summary)}.`,
    "Keep the commit limited to the staged selection.",
  ];
  if (summary.touchesTests) {
    lines.push("Includes test-related changes.");
  }
  return lines.join("\n");
}

function suggestedDraftType(
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
): string | undefined {
  if (!policy.conventionalCommit.enabled) return undefined;
  const { allowedTypes } = policy.conventionalCommit;
  if (intent.suggestedType !== undefined && allowedTypes.includes(intent.suggestedType)) {
    return intent.suggestedType;
  }
  if (allowedTypes.includes("chore")) return "chore";
  return allowedTypes[0];
}

function draftSubject(intent: GitCommitIntentAnalysis, policy: GitCommitMessagePolicy): string {
  const type = suggestedDraftType(intent, policy);
  return type === undefined ? GENERIC_DRAFT_SUBJECT : `${type}: update staged changes`;
}

/**
 * Returns a conservative, policy-valid commit subject derived from the staged-change intent, when
 * that is possible without inventing user-specific data. The result is always safe to put into the
 * editable commit composer, but it never bypasses the server's fresh pre-commit validation.
 */
export function suggestGitCommitMessage(
  intent: GitCommitIntentAnalysis,
  policy: GitCommitMessagePolicy,
  summary?: GitCommitChangeSummary,
): string | undefined {
  const subject = draftSubject(intent, policy);
  if (subject.length > policy.subjectMaxLength) return undefined;
  const message = summary === undefined ? subject : `${subject}\n\n${draftBody(summary)}`;
  return validateGitCommitMessage(message, policy).ok ? message : undefined;
}

// ─── Exported guards ────────────────────────────────────────────────────────────────────────────

export const isGitCommitQualityWarningCode = isInSet(GIT_COMMIT_QUALITY_WARNING_CODES);

export function isGitCommitChangeSummary(value: unknown): value is GitCommitChangeSummary {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.stagedFileCount) &&
    isNonNegativeInteger(value.areaCount) &&
    isStringArray(value.areas) &&
    isBoolean(value.touchesTests)
  );
}

function isWarningArray(value: unknown): value is readonly GitCommitQualityWarningCode[] {
  return Array.isArray(value) && value.every(isGitCommitQualityWarningCode);
}

export function isGitCommitIntentAnalysis(value: unknown): value is GitCommitIntentAnalysis {
  return (
    isRecord(value) &&
    isWarningArray(value.warnings) &&
    isBoolean(value.mixedScope) &&
    isBoolean(value.isWip) &&
    isUndefinedOr(isString)(value.suggestedType) &&
    isUndefinedOr(isString)(value.suggestedScope) &&
    isUndefinedOr(isString)(value.suggestedSubjectPrefix)
  );
}
