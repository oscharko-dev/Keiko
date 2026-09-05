import type { GitChangeSnapshot, GitChangeSnapshotCompleteness } from "./git-change-snapshot.js";
import { deepFreeze } from "./deep-freeze.js";
import {
  containsAbsolutePath,
  containsPseudoRoleMarker,
  hasControlCharacter,
  stripUnsafeFormatChars,
} from "./text-safety.js";
import { containsPrDescriptionMarker } from "./pr-description-region.js";

export const PR_DESCRIPTION_SCHEMA_VERSION = "1" as const;
export const PR_DESCRIPTION_RENDERING_VERSION = "1" as const;
export const PR_DESCRIPTION_LANGUAGES = ["en", "de"] as const;
export type PrDescriptionLanguage = (typeof PR_DESCRIPTION_LANGUAGES)[number];
export const PR_DESCRIPTION_OUTCOMES = ["complete", "partial", "fallback", "failed"] as const;
export type PrDescriptionOutcome = (typeof PR_DESCRIPTION_OUTCOMES)[number];
export const PR_DESCRIPTION_SECTION_KEYS = [
  "summary",
  "keyChanges",
  "risks",
  "reviewerFocus",
] as const;
export type PrDescriptionSection = (typeof PR_DESCRIPTION_SECTION_KEYS)[number];
export const PR_DESCRIPTION_TEXT_MAX_LENGTH = 600;
export const PR_DESCRIPTION_SECTION_MAX_ITEMS = 6;
export const PR_DESCRIPTION_REFERENCE_MAX_ITEMS = 8;
export const PR_DESCRIPTION_CANDIDATE_MAX_BYTES = 24_576;

export interface PrDescriptionStatement {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

/** Model-owned content only. Verification claims, framing, URLs and authority have no field. */
export type PrDescriptionCandidate = Readonly<
  Record<PrDescriptionSection, readonly PrDescriptionStatement[]>
>;

export type PrDescriptionBinding = Pick<
  GitChangeSnapshot,
  | "repositoryId"
  | "remoteDigest"
  | "baseRef"
  | "baseSha"
  | "headRef"
  | "headSha"
  | "mergeBaseSha"
  | "snapshotDigest"
>;

export const PR_DESCRIPTION_REASONS = [
  "none",
  "model-unavailable",
  "invalid-model-output",
  "unsafe-model-output",
  "provider-failed",
  "budget-exhausted",
  "cancelled",
  "timeout",
  "snapshot-unavailable",
  "invalid-snapshot",
  "invalid-request",
  "authority-denied",
] as const;
export type PrDescriptionReason = (typeof PR_DESCRIPTION_REASONS)[number];

export interface PrDescriptionCoverage {
  readonly snapshot: GitChangeSnapshotCompleteness;
  readonly suppliedEvidenceCount: number;
  readonly processedEvidenceCount: number;
  readonly omittedEvidenceCount: number;
}

/** Transient access-controlled artifact; the durable projection below deliberately omits bodies. */
export interface PrDescriptionArtifact {
  readonly schemaVersion: typeof PR_DESCRIPTION_SCHEMA_VERSION;
  readonly renderingVersion: typeof PR_DESCRIPTION_RENDERING_VERSION;
  readonly binding: PrDescriptionBinding;
  readonly language: PrDescriptionLanguage;
  readonly outcome: PrDescriptionOutcome;
  readonly reason: PrDescriptionReason;
  readonly coverage: PrDescriptionCoverage;
  readonly candidate: PrDescriptionCandidate;
  readonly markdown: string;
  readonly artifactDigest: string;
}

export interface PrDescriptionArtifactEvidence {
  readonly schemaVersion: typeof PR_DESCRIPTION_SCHEMA_VERSION;
  readonly renderingVersion: typeof PR_DESCRIPTION_RENDERING_VERSION;
  readonly snapshotDigest: string;
  readonly artifactDigest: string;
  readonly outcome: PrDescriptionOutcome;
  readonly reason: PrDescriptionReason;
  readonly processedEvidenceCount: number;
  readonly omittedEvidenceCount: number;
}

/** One domain-separated producer for hashing and later apply-time integrity checks. */
export function prDescriptionArtifactDigestFields(
  artifact: Omit<PrDescriptionArtifact, "artifactDigest">,
): Readonly<Record<string, unknown>> {
  return {
    domain: "keiko-pr-description-v1",
    schemaVersion: artifact.schemaVersion,
    renderingVersion: artifact.renderingVersion,
    binding: artifact.binding,
    language: artifact.language,
    outcome: artifact.outcome,
    reason: artifact.reason,
    coverage: artifact.coverage,
    candidate: artifact.candidate,
    markdown: artifact.markdown,
  };
}

export function freezePrDescriptionArtifact(
  artifact: PrDescriptionArtifact,
): PrDescriptionArtifact {
  return deepFreeze(artifact);
}

export function prDescriptionArtifactEvidence(
  artifact: PrDescriptionArtifact,
): PrDescriptionArtifactEvidence {
  return {
    schemaVersion: artifact.schemaVersion,
    renderingVersion: artifact.renderingVersion,
    snapshotDigest: artifact.binding.snapshotDigest,
    artifactDigest: artifact.artifactDigest,
    outcome: artifact.outcome,
    reason: artifact.reason,
    processedEvidenceCount: artifact.coverage.processedEvidenceCount,
    omittedEvidenceCount: artifact.coverage.omittedEvidenceCount,
  };
}

export function prDescriptionBinding(snapshot: GitChangeSnapshot): PrDescriptionBinding {
  return {
    repositoryId: snapshot.repositoryId,
    ...(snapshot.remoteDigest === undefined ? {} : { remoteDigest: snapshot.remoteDigest }),
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    headRef: snapshot.headRef,
    headSha: snapshot.headSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    snapshotDigest: snapshot.snapshotDigest,
  };
}

const STATEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "evidenceIds"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: PR_DESCRIPTION_TEXT_MAX_LENGTH },
    evidenceIds: {
      type: "array",
      minItems: 1,
      maxItems: PR_DESCRIPTION_REFERENCE_MAX_ITEMS,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
};

/** The same closed shape and bounds are used for provider schema and local validation. */
export const PR_DESCRIPTION_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [...PR_DESCRIPTION_SECTION_KEYS],
  properties: Object.fromEntries(
    PR_DESCRIPTION_SECTION_KEYS.map((key) => [
      key,
      {
        type: "array",
        minItems: key === "summary" || key === "keyChanges" ? 1 : 0,
        maxItems: PR_DESCRIPTION_SECTION_MAX_ITEMS,
        items: STATEMENT_SCHEMA,
      },
    ]),
  ),
});

export type PrDescriptionCandidateValidation =
  | { readonly ok: true; readonly value: PrDescriptionCandidate }
  | { readonly ok: false; readonly reason: "invalid-model-output" | "unsafe-model-output" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}

/** No execution evidence exists in the diff snapshot. Never publish a model's success assurance. */
const UNSUPPORTED_ASSURANCE =
  /\b(?:pass(?:ed|ing)?|succeeded|verified|proven|guaranteed|risk[- ]free|secure|safe|successful|bestanden|verifiziert|garantiert|sicher|erfolgreich)\b/iu;
const ACTIVE_MARKDOWN = /[<>[\]`]|(?:https?:|javascript:|data:)\/\/|!\(|\bby\s+Keiko\b/iu;
const CLOSING_DIRECTIVE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(?:#|[a-z0-9_.-]+\/[a-z0-9_.-]+#)/iu;

export function isSafePrDescriptionText(text: string): boolean {
  return (
    text.trim().length > 0 &&
    text.length <= PR_DESCRIPTION_TEXT_MAX_LENGTH &&
    stripUnsafeFormatChars(text) === text &&
    !hasControlCharacter(text) &&
    !containsAbsolutePath(text) &&
    !containsPseudoRoleMarker(text) &&
    !containsPrDescriptionMarker(text) &&
    !ACTIVE_MARKDOWN.test(text) &&
    !CLOSING_DIRECTIVE.test(text) &&
    !UNSUPPORTED_ASSURANCE.test(text)
  );
}

function validReferences(value: unknown, known: ReadonlySet<string>): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= PR_DESCRIPTION_REFERENCE_MAX_ITEMS &&
    Array.from(value).every(
      (id: unknown) => typeof id === "string" && /^[a-f0-9]{64}$/u.test(id) && known.has(id),
    ) &&
    new Set(value).size === value.length
  );
}

function statementFailure(
  value: unknown,
  known: ReadonlySet<string>,
): PrDescriptionReason | undefined {
  if (!isPlainRecord(value) || !exactKeys(value, ["text", "evidenceIds"]))
    return "invalid-model-output";
  if (typeof value.text !== "string" || !validReferences(value.evidenceIds, known))
    return "invalid-model-output";
  return isSafePrDescriptionText(value.text) ? undefined : "unsafe-model-output";
}

function sectionFailure(
  value: unknown,
  key: PrDescriptionSection,
  known: ReadonlySet<string>,
): PrDescriptionReason | undefined {
  if (!Array.isArray(value) || value.length > PR_DESCRIPTION_SECTION_MAX_ITEMS)
    return "invalid-model-output";
  if ((key === "summary" || key === "keyChanges") && value.length === 0)
    return "invalid-model-output";
  for (const statement of value) {
    const failure = statementFailure(statement, known);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

export function validatePrDescriptionCandidate(
  value: unknown,
  evidenceIds: readonly string[],
): PrDescriptionCandidateValidation {
  if (!isPlainRecord(value) || !exactKeys(value, PR_DESCRIPTION_SECTION_KEYS))
    return { ok: false, reason: "invalid-model-output" };
  const known = new Set(evidenceIds);
  for (const key of PR_DESCRIPTION_SECTION_KEYS) {
    const reason = sectionFailure(value[key], key, known);
    if (reason !== undefined)
      return {
        ok: false,
        reason: reason === "unsafe-model-output" ? reason : "invalid-model-output",
      };
  }
  return { ok: true, value: value as PrDescriptionCandidate };
}
