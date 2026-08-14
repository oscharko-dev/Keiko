// Producer-owned acceptance contribution for Epic #2384 Code-task children (#2385 owns the
// definition; #2396 consumes and aggregates it and must not redefine it). Every child PR emits
// one contribution bound to its final source/tree SHA. The payload is content-free by contract:
// ids, digests, counts, outcomes, and repo-relative paths only — never file bodies, prompts,
// commands, endpoints, or credentials.
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";

export const CODE_TASK_ACCEPTANCE_SCHEMA_VERSION = 1;

export const CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND = "code-task-acceptance-contribution";

/** Mandatory evidence classes from the #2384 enterprise acceptance gate. */
export const CODE_TASK_EVIDENCE_CLASSES = Object.freeze([
  "unit-contract",
  "mocked-failure-integration",
  "production-functional",
  "playwright-journey",
  "packaged-computer-use",
] as const satisfies readonly string[]);

/** Release-blocking desktop targets plus the CI evidence host. */
export const CODE_TASK_EVIDENCE_PLATFORMS = Object.freeze([
  "windows-x64",
  "macos-arm64",
  "macos-x64",
  "linux-x64",
] as const satisfies readonly string[]);

export const CODE_TASK_SCENARIO_OUTCOMES = Object.freeze([
  "passed",
  "failed",
  "blocked",
] as const satisfies readonly string[]);

export const CODE_TASK_SALVAGE_DISPOSITIONS = Object.freeze([
  "taken-verbatim",
  "reshaped",
  "rejected",
] as const satisfies readonly string[]);

export type CodeTaskEvidenceClass = (typeof CODE_TASK_EVIDENCE_CLASSES)[number];
export type CodeTaskEvidencePlatform = (typeof CODE_TASK_EVIDENCE_PLATFORMS)[number];
export type CodeTaskScenarioOutcome = (typeof CODE_TASK_SCENARIO_OUTCOMES)[number];
export type CodeTaskSalvageDisposition = (typeof CODE_TASK_SALVAGE_DISPOSITIONS)[number];

declare const codeTaskBrand: unique symbol;

/**
 * Validated branded opaque value (#2384 type rule). The brand is type-level only, so branded
 * values stay JSON-serializable primitives at runtime.
 */
export type CodeTaskBranded<Name extends string, Value> = Value & {
  readonly [codeTaskBrand]: Name;
};

export type CodeTaskGitCommitSha = CodeTaskBranded<"CodeTaskGitCommitSha", string>;
export type CodeTaskGitTreeSha = CodeTaskBranded<"CodeTaskGitTreeSha", string>;
export type CodeTaskSha256Digest = CodeTaskBranded<"CodeTaskSha256Digest", string>;
export type CodeTaskScenarioId = CodeTaskBranded<"CodeTaskScenarioId", string>;
export type CodeTaskIsoInstant = CodeTaskBranded<"CodeTaskIsoInstant", string>;

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const REPO_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const CONTENT_FREE_NOTE_PATTERN = /^[\x20-\x7E]{1,200}$/u;
const NOTE_SECRET_MARKERS = /(?:secret|token|password|api[-_]?key|bearer |ghp_|-----BEGIN)/iu;

export function isCodeTaskGitCommitSha(value: unknown): value is CodeTaskGitCommitSha {
  return typeof value === "string" && GIT_SHA_PATTERN.test(value);
}

export function isCodeTaskGitTreeSha(value: unknown): value is CodeTaskGitTreeSha {
  return typeof value === "string" && GIT_SHA_PATTERN.test(value);
}

export function isCodeTaskSha256Digest(value: unknown): value is CodeTaskSha256Digest {
  return typeof value === "string" && SHA_256_PATTERN.test(value);
}

export function isCodeTaskScenarioId(value: unknown): value is CodeTaskScenarioId {
  return typeof value === "string" && SCENARIO_ID_PATTERN.test(value);
}

export function isCodeTaskIsoInstant(value: unknown): value is CodeTaskIsoInstant {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Round-trip guard: engines roll impossible calendar dates over instead of rejecting them.
  const canonical = new Date(parsed).toISOString();
  return canonical === value || canonical === value.replace("Z", ".000Z");
}

/** Repo-relative file path: no absolute roots, drive letters, backslashes, or parent escapes. */
export function isCodeTaskRepoRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    REPO_RELATIVE_PATH_PATTERN.test(value) &&
    !value.split("/").includes("..")
  );
}

/** Bounded printable note that must stay content-free (no secret-shaped material). */
export function isCodeTaskContentFreeNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CONTENT_FREE_NOTE_PATTERN.test(value) &&
    !NOTE_SECRET_MARKERS.test(value)
  );
}

/**
 * Explicit tagged outcome for an optional fact (#2384 type rule): `undefined`, empty strings,
 * and inferred values are not valid representations of missing knowledge.
 */
export type CodeTaskFact<Value> =
  | { readonly outcome: "known"; readonly value: Value }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "absent" };

export interface CodeTaskAcceptanceScenarioV1 {
  readonly scenarioId: CodeTaskScenarioId;
  readonly evidenceClass: CodeTaskEvidenceClass;
  readonly platform: CodeTaskEvidencePlatform;
  readonly outcome: CodeTaskScenarioOutcome;
  readonly recordedAt: CodeTaskIsoInstant;
  /** Digests of the produced evidence artifacts; content stays outside the contribution. */
  readonly artifactDigests: readonly CodeTaskSha256Digest[];
  readonly receiptDigest: CodeTaskFact<CodeTaskSha256Digest>;
}

export interface CodeTaskSalvageRowV1 {
  readonly sourceBranch: string;
  readonly sourceSha: CodeTaskGitCommitSha;
  readonly path: string;
  readonly disposition: CodeTaskSalvageDisposition;
  readonly reshaping: CodeTaskFact<string>;
  readonly verifiedAtSha: CodeTaskGitCommitSha;
}

export type CodeTaskCleanupResultV1 =
  { readonly state: "complete" } | { readonly state: "incomplete"; readonly residueCount: number };

export interface CodeTaskAcceptanceContributionV1 {
  readonly kind: typeof CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND;
  readonly schemaVersion: typeof CODE_TASK_ACCEPTANCE_SCHEMA_VERSION;
  readonly epicIssue: number;
  readonly childIssue: number;
  readonly sourceCommitSha: CodeTaskGitCommitSha;
  readonly sourceTreeSha: CodeTaskGitTreeSha;
  readonly scenarios: readonly CodeTaskAcceptanceScenarioV1[];
  readonly salvage: readonly CodeTaskSalvageRowV1[];
  readonly knownLimitations: readonly string[];
  readonly cleanup: CodeTaskCleanupResultV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function factErrors(
  value: unknown,
  path: string,
  isValue: (candidate: unknown) => boolean,
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be a tagged fact object`];
  if (value.outcome === "known") {
    return isValue(value.value) ? [] : [`${path}.value is invalid for a known fact`];
  }
  if (
    value.outcome === "unknown" ||
    value.outcome === "unavailable" ||
    value.outcome === "absent"
  ) {
    return "value" in value ? [`${path} must not carry a value for outcome ${value.outcome}`] : [];
  }
  return [`${path}.outcome must be known, unknown, unavailable, or absent`];
}

// Closed key sets. Every peer validator in this territory enforces one and says why — an unexpected
// field on a documented content-free contract must never ride through into evidence. These four did
// not, so a payload could carry `promptText` (or any other free-text field) alongside the validated
// ones and be accepted, then be handed on as `value`. Mirrors code-task-governance.ts's unknownKeys.
function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): readonly string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
}

const CONTRIBUTION_KEYS = [
  "kind",
  "schemaVersion",
  "epicIssue",
  "childIssue",
  "sourceCommitSha",
  "sourceTreeSha",
  "scenarios",
  "salvage",
  "knownLimitations",
  "cleanup",
] as const;

const SCENARIO_KEYS = [
  "scenarioId",
  "evidenceClass",
  "platform",
  "outcome",
  "recordedAt",
  "artifactDigests",
  "receiptDigest",
] as const;

const SALVAGE_KEYS = [
  "sourceBranch",
  "sourceSha",
  "path",
  "disposition",
  "reshaping",
  "verifiedAtSha",
] as const;

const CLEANUP_KEYS = ["state", "residueCount"] as const;

function scenarioErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [...unknownKeys(value, SCENARIO_KEYS, path)];
  if (!isCodeTaskScenarioId(value.scenarioId)) errors.push(`${path}.scenarioId is invalid`);
  if (!isOneOf(value.evidenceClass, CODE_TASK_EVIDENCE_CLASSES)) {
    errors.push(`${path}.evidenceClass is not a registered evidence class`);
  }
  if (!isOneOf(value.platform, CODE_TASK_EVIDENCE_PLATFORMS)) {
    errors.push(`${path}.platform is not a supported evidence platform`);
  }
  if (!isOneOf(value.outcome, CODE_TASK_SCENARIO_OUTCOMES)) {
    errors.push(`${path}.outcome must be passed, failed, or blocked`);
  }
  if (!isCodeTaskIsoInstant(value.recordedAt)) {
    errors.push(`${path}.recordedAt must be an ISO-8601 UTC instant`);
  }
  if (
    !Array.isArray(value.artifactDigests) ||
    !value.artifactDigests.every((digest) => isCodeTaskSha256Digest(digest))
  ) {
    errors.push(`${path}.artifactDigests must be an array of sha256 digests`);
  }
  errors.push(...factErrors(value.receiptDigest, `${path}.receiptDigest`, isCodeTaskSha256Digest));
  return errors;
}

function salvageErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [...unknownKeys(value, SALVAGE_KEYS, path)];
  if (!isCodeTaskContentFreeNote(value.sourceBranch)) {
    errors.push(`${path}.sourceBranch must be a bounded content-free reference`);
  }
  if (!isCodeTaskGitCommitSha(value.sourceSha)) errors.push(`${path}.sourceSha is invalid`);
  if (!isCodeTaskRepoRelativePath(value.path)) {
    errors.push(`${path}.path must be a repo-relative path`);
  }
  if (!isOneOf(value.disposition, CODE_TASK_SALVAGE_DISPOSITIONS)) {
    errors.push(`${path}.disposition must be taken-verbatim, reshaped, or rejected`);
  }
  errors.push(...factErrors(value.reshaping, `${path}.reshaping`, isCodeTaskContentFreeNote));
  if (!isCodeTaskGitCommitSha(value.verifiedAtSha)) errors.push(`${path}.verifiedAtSha is invalid`);
  return errors;
}

function cleanupErrors(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["cleanup must be an object"];
  const unknown = unknownKeys(value, CLEANUP_KEYS, "cleanup");
  if (value.state === "complete") {
    return "residueCount" in value
      ? [...unknown, "cleanup.residueCount is only valid when incomplete"]
      : unknown;
  }
  if (value.state === "incomplete") {
    return isPositiveInteger(value.residueCount)
      ? unknown
      : [...unknown, "cleanup.residueCount must be a positive integer when incomplete"];
  }
  return [...unknown, "cleanup.state must be complete or incomplete"];
}

function contributionHeaderErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (value.kind !== CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND) {
    errors.push(`kind must be ${CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND}`);
  }
  if (value.schemaVersion !== CODE_TASK_ACCEPTANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isPositiveInteger(value.epicIssue)) errors.push("epicIssue must be a positive integer");
  if (!isPositiveInteger(value.childIssue)) errors.push("childIssue must be a positive integer");
  if (!isCodeTaskGitCommitSha(value.sourceCommitSha)) errors.push("sourceCommitSha is invalid");
  if (!isCodeTaskGitTreeSha(value.sourceTreeSha)) errors.push("sourceTreeSha is invalid");
  return errors;
}

function contributionBodyErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (Array.isArray(value.scenarios)) {
    value.scenarios.forEach((scenario, index) => {
      errors.push(...scenarioErrors(scenario, `scenarios[${String(index)}]`));
    });
  } else {
    errors.push("scenarios must be an array");
  }
  if (Array.isArray(value.salvage)) {
    value.salvage.forEach((row, index) => {
      errors.push(...salvageErrors(row, `salvage[${String(index)}]`));
    });
  } else {
    errors.push("salvage must be an array");
  }
  if (
    !Array.isArray(value.knownLimitations) ||
    !value.knownLimitations.every((note) => isCodeTaskContentFreeNote(note))
  ) {
    errors.push("knownLimitations must be an array of bounded content-free notes");
  }
  errors.push(...cleanupErrors(value.cleanup));
  return errors;
}

export function validateCodeTaskAcceptanceContribution(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskAcceptanceContributionV1> {
  if (!isRecord(value)) return { ok: false, errors: ["contribution must be an object"] };
  const errors = [
    ...unknownKeys(value, CONTRIBUTION_KEYS, "contribution"),
    ...contributionHeaderErrors(value),
    ...contributionBodyErrors(value),
  ];
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodeTaskAcceptanceContributionV1 };
}

export interface CodeTaskAcceptanceBinding {
  readonly epicIssue: number;
  readonly childIssue: number;
  readonly sourceCommitSha: string;
  readonly registeredScenarioIds: readonly string[];
}

/**
 * Consumer-side qualification rules for #2396: a structurally valid contribution still fails
 * qualification when it is empty, bound to a foreign or stale SHA, references an unregistered
 * scenario, or reports incomplete cleanup. Failures are content-free strings.
 */
export function codeTaskAcceptanceQualificationFailures(
  contribution: CodeTaskAcceptanceContributionV1,
  binding: CodeTaskAcceptanceBinding,
): readonly string[] {
  const failures: string[] = [];
  if (contribution.scenarios.length === 0) {
    failures.push("empty contribution: at least one scenario is required");
  }
  if (contribution.epicIssue !== binding.epicIssue) failures.push("foreign epic issue binding");
  if (contribution.childIssue !== binding.childIssue) failures.push("foreign child issue binding");
  if (contribution.sourceCommitSha !== binding.sourceCommitSha) {
    failures.push("stale or foreign source SHA binding");
  }
  const registered = new Set(binding.registeredScenarioIds);
  for (const scenario of contribution.scenarios) {
    if (!registered.has(scenario.scenarioId)) {
      failures.push(`unregistered scenario: ${scenario.scenarioId}`);
    }
  }
  if (contribution.cleanup.state === "incomplete") {
    failures.push(
      `incomplete cleanup: ${String(
        isNonNegativeInteger(contribution.cleanup.residueCount)
          ? contribution.cleanup.residueCount
          : 0,
      )} residues`,
    );
  }
  return failures;
}
