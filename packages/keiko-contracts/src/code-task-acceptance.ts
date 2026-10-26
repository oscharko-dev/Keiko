import {
  hasInheritedEnumerableProperty as recordHasInheritedEnumerableProperty,
  isCodeTaskRecord as isRecord,
  validateCodeTaskTaggedFact,
  validateCodeTaskOwnKeys,
} from "./code-task-record-validation.js";
// Producer-owned acceptance contribution for Epic #2384 Code-task children (#2385 owns the
// definition; #2396 consumes and aggregates it and must not redefine it). Every child PR emits
// one contribution bound to its final source/tree SHA. The payload is content-free by contract:
// ids, digests, counts, outcomes, and repo-relative paths only — never file bodies, prompts,
// commands, endpoints, or credentials.
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  permissionKindForSupervisedCodingAction,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchMode,
  type CodingWorkbenchSupervisedActionKind,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { isGitCiReadinessEvidenceRef } from "./git-ci-readiness.js";

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
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const REPO_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const CONTENT_FREE_NOTE_PATTERN = /^[\x20-\x7E]{1,200}$/u;
const NOTE_SECRET_MARKERS = /(?:secret|token|password|api[-_]?key|bearer |ghp_|-----BEGIN)/iu;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function matchesCodeTaskStringPattern(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

export function isCodeTaskGitCommitSha(value: unknown): value is CodeTaskGitCommitSha {
  return matchesCodeTaskStringPattern(value, GIT_SHA_PATTERN);
}

export function isCodeTaskGitTreeSha(value: unknown): value is CodeTaskGitTreeSha {
  return matchesCodeTaskStringPattern(value, GIT_SHA_PATTERN);
}

export function isCodeTaskSha256Digest(value: unknown): value is CodeTaskSha256Digest {
  return matchesCodeTaskStringPattern(value, SHA_256_PATTERN);
}

export function isCodeTaskScenarioId(value: unknown): value is CodeTaskScenarioId {
  return matchesCodeTaskStringPattern(value, SCENARIO_ID_PATTERN);
}

/** A governed-tool catalog name (e.g. `keiko_changeset_edit`): content-free by construction, never
 * a prompt, argument, or result. */
export function isCodeTaskToolName(value: unknown): value is string {
  return matchesCodeTaskStringPattern(value, TOOL_NAME_PATTERN);
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

// KfQ Critical (threads on unknownKeys, :214/:359): a value shaped via Object.create(secretHolder)
// can carry every required field as an OWN property (so it looks complete) plus one extra field
// reachable ONLY through the prototype -- verified empirically that such a value's own-property
// count and own-property names match an honest input exactly, so neither Object.keys nor
// Object.getOwnPropertyNames nor an exact-own-count check (the closed-key mechanisms this file
// otherwise uses) ever see the extra field, while ordinary property access on it still resolves
// through the prototype chain. Rejecting any non-default prototype closes this at the single choke
// point every validator in this file already passes through, rather than only at the specific
// unknownKeys call sites the finding named.
function addValidationError(errors: string[], message: string): false {
  errors.push(message);
  return false;
}

function acceptanceArrayMembersAreValid(
  errors: string[],
  value: unknown,
  path: string,
  validateMember: (member: unknown, index: number) => boolean,
): boolean {
  if (!Array.isArray(value)) return addValidationError(errors, `${path} must be an array`);
  const entries: readonly unknown[] = value;
  return acceptanceMembersAreValid(errors, entries, path, validateMember);
}

function acceptanceMembersAreValid(
  errors: string[],
  entries: readonly unknown[],
  path: string,
  validateMember: (member: unknown, index: number) => boolean,
): boolean {
  const length = entries.length;
  let valid = true;
  for (let index = 0; index < length; index += 1) {
    if (!(index in entries)) {
      return addValidationError(errors, `${path}[${String(index)}] must be an object`);
    }
    const member: unknown = entries[index];
    valid = validateMember(member, index) && valid;
  }
  return valid;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A bounded, non-negative USD amount (issue #3390 audit F15): finite, never negative, and capped
 * well above any plausible single-run evaluation budget so a malformed/overflowed value cannot
 * pass as a spend fact. */
function isNonNegativeAmountUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
}

// KEIKO-0302 follow-on: this closed the CONTRIBUTION's outer keys but never the fact object's own
// keys, so a well-formed `{ outcome: "known", value: <valid digest> }` padded with an extra field
// (e.g. free text riding alongside the digest) validated and was returned verbatim — the exact
// boundary this contract documents itself as content-free. A known fact may carry only `outcome`
// and `value`; every other outcome may carry only `outcome`.
// Codex P1 (threads 3789537202, 3789635890): checking one inherited key at a time is an unbounded
// game of whack-a-mole. Round one restored a check for an inherited `value`; Codex then showed the
// SAME gap exists for the discriminator itself -- Object.prototype polluted with `outcome:
// "absent"` lets an otherwise-EMPTY object resolve that branch via ordinary property access, with
// zero own properties for unknownKeys' Object.getOwnPropertyNames scan to ever see -- and for any
// undeclared field (a polluted, inherited `promptText` rides along on the object this validator
// hands onward by reference, since every exported validator here returns its input by reference,
// not a reconstructed copy). A legitimate JSON-sourced fact never has ANY inherited enumerable
// property at all (JSON.parse always produces a plain object with none), so rejecting the general
// case closes every specific one at once instead of naming another key every time a new one is
// found. Exported so a test can call the actual guard directly with a crafted object, bypassing
// isRecord on purpose: isRecord answers a different question ("is this a plain object"), and
// rejecting a non-default prototype there is exactly why this guard is otherwise unreachable from
// outside -- every real caller already goes through isRecord first, but a test targeting THIS
// function does not have to. for...in is the right tool for "does anything resolve here that this
// object does not itself own", unlike debug-lifecycle.ts's plain `in` for closed-set MEMBERSHIP,
// where prototype traversal is exactly the bug (it would accept "constructor" as a member).
// Also checked empirically, not just reasoned about: a Proxy whose getPrototypeOf trap reports the
// real Object.prototype (to clear isRecord) cannot desynchronize this loop from Object.hasOwn
// either -- for...in's enumerability check and Object.hasOwn both resolve through the same
// [[GetOwnProperty]] trap call on the same object, so any trap shape that makes for...in see a key
// as enumerable-and-own-at-this-level makes Object.hasOwn report it as own too. No crafted value,
// proxy or otherwise, clears isRecord and still makes this function return a false negative without
// mutating the real global Object.prototype.
// Retired as the load-bearing check by Codex P1 3789773829: for...in only visits ENUMERABLE
// properties, own or inherited, so Object.defineProperty(Object.prototype, "outcome", { value:
// "absent", enumerable: false }) is invisible to this loop while `record.outcome` still resolves
// to "absent" through ordinary property access -- the same "empty object smuggles a discriminator"
// attack this function exists to catch, just via a descriptor shape it does not look at. A
// detector that walks descriptor space (enumerable, then non-enumerable, then whatever comes
// next) is always one step behind an attacker who can vary the descriptor, so every validator in
// this file now reads contract fields through ownField below instead of trusting `value.outcome`
// directly -- that is the complete, terminating fix; this function stays only as an early,
// cheaper rejection for the common (enumerable) case, kept for defense in depth, not because it is
// still sufficient on its own.
// KfQ 3789776158: this is exported for the direct-call tests below, so a caller reaching for it in
// isolation could mistake it for a complete validator. It is not: it does not check that `record`'s
// own prototype is Object.prototype (pair it with isRecord for that) and, per the paragraph above,
// it only catches an ENUMERABLE inherited property -- ownField is what actually closes the general
// case; this function alone closes neither.
// Compatibility delegate: the single implementation now lives with the private record guards.
export function hasInheritedEnumerableProperty(record: Record<string, unknown>): boolean {
  return recordHasInheritedEnumerableProperty(record);
}

// Codex P1 3789773829, the terminating fix: a detector inspects a property's descriptor to decide
// whether it is "suspicious" (enumerable? inherited? both?), and an attacker who controls
// Object.prototype controls the descriptor, so there is always a shape the detector has not been
// taught yet (enumerable value, then enumerable outcome, then non-enumerable outcome -- and
// nothing rules out a getter, a Symbol.toPrimitive trick, or the next thing not yet named). Object
// .hasOwn is invariant to every one of those: it answers ownership, never resolution, regardless
// of enumerable/configurable/writable/accessor-vs-data. Gating every contract-field read through
// this function means nothing here ever asks the prototype chain a question in the first place, so
// there is no descriptor shape left to exploit. Returns unknown, matching how a fresh property read
// off Record<string, unknown> already behaved before this change -- callers narrow it exactly as
// they narrowed `value.someField` before.
export function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function knownFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
  isValue: (candidate: unknown) => boolean,
): boolean {
  let valid = true;
  // Collected, not early-returned: an object can carry both an extra own key and an invalid
  // value, and both are worth reporting (KfQ 3789542365 raised this for the branch below; the
  // same shape applied here).
  valid = validateCodeTaskOwnKeys(errors, value, ["outcome", "value"], path) && valid;
  if (!isValue(ownField(value, "value"))) {
    valid = addValidationError(errors, `${path}.value is invalid for a known fact`);
  }
  return valid;
}

function factFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
  isValue: (candidate: unknown) => boolean,
): boolean {
  return validateCodeTaskTaggedFact(errors, value, path, (record) =>
    knownFactFieldsAreValid(errors, record, path, isValue),
  );
}

// Closed key sets. Every peer validator in this territory enforces one and says why — an unexpected
// field on a documented content-free contract must never ride through into evidence. These four did
// not, so a payload could carry `promptText` (or any other free-text field) alongside the validated
// ones and be accepted, then be handed on as `value`. Mirrors code-task-governance.ts's unknownKeys.
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

function scenarioFieldsAreValid(errors: string[], value: unknown, path: string): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, SCENARIO_KEYS, path) && valid;
  if (!isCodeTaskScenarioId(ownField(value, "scenarioId"))) {
    valid = addValidationError(errors, `${path}.scenarioId is invalid`);
  }
  if (!isOneOf(ownField(value, "evidenceClass"), CODE_TASK_EVIDENCE_CLASSES)) {
    valid = addValidationError(errors, `${path}.evidenceClass is not a registered evidence class`);
  }
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    valid = addValidationError(errors, `${path}.platform is not a supported evidence platform`);
  }
  if (!isOneOf(ownField(value, "outcome"), CODE_TASK_SCENARIO_OUTCOMES)) {
    valid = addValidationError(errors, `${path}.outcome must be passed, failed, or blocked`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    valid = addValidationError(errors, `${path}.recordedAt must be an ISO-8601 UTC instant`);
  }
  const artifactDigests = ownField(value, "artifactDigests");
  if (!isDigestArray(artifactDigests)) {
    valid = addValidationError(
      errors,
      `${path}.artifactDigests must be an array of sha256 digests`,
    );
  }
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "receiptDigest"),
      `${path}.receiptDigest`,
      isCodeTaskSha256Digest,
    ) && valid;
  return valid;
}

function salvageFieldsAreValid(errors: string[], value: unknown, path: string): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, SALVAGE_KEYS, path) && valid;
  if (!isCodeTaskContentFreeNote(ownField(value, "sourceBranch"))) {
    valid = addValidationError(
      errors,
      `${path}.sourceBranch must be a bounded content-free reference`,
    );
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "sourceSha"))) {
    valid = addValidationError(errors, `${path}.sourceSha is invalid`);
  }
  if (!isCodeTaskRepoRelativePath(ownField(value, "path"))) {
    valid = addValidationError(errors, `${path}.path must be a repo-relative path`);
  }
  if (!isOneOf(ownField(value, "disposition"), CODE_TASK_SALVAGE_DISPOSITIONS)) {
    valid = addValidationError(
      errors,
      `${path}.disposition must be taken-verbatim, reshaped, or rejected`,
    );
  }
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "reshaping"),
      `${path}.reshaping`,
      isCodeTaskContentFreeNote,
    ) && valid;
  if (!isCodeTaskGitCommitSha(ownField(value, "verifiedAtSha"))) {
    valid = addValidationError(errors, `${path}.verifiedAtSha is invalid`);
  }
  return valid;
}

function cleanupFieldsAreValid(errors: string[], value: unknown): boolean {
  if (!isRecord(value)) return addValidationError(errors, "cleanup must be an object");
  const closed = validateCodeTaskOwnKeys(errors, value, CLEANUP_KEYS, "cleanup");
  const state = ownField(value, "state");
  if (state === "complete") {
    const fields =
      !Object.hasOwn(value, "residueCount") ||
      addValidationError(errors, "cleanup.residueCount is only valid when incomplete");
    return closed && fields;
  }
  if (state === "incomplete") {
    const fields =
      isPositiveInteger(ownField(value, "residueCount")) ||
      addValidationError(errors, "cleanup.residueCount must be a positive integer when incomplete");
    return closed && fields;
  }
  return addValidationError(errors, "cleanup.state must be complete or incomplete");
}

// Both acceptance evidence documents bind their claims to the same issue and source revision.
function sourceProvenanceFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  if (!isPositiveInteger(ownField(value, "epicIssue"))) {
    valid = addValidationError(errors, "epicIssue must be a positive integer");
  }
  if (!isPositiveInteger(ownField(value, "childIssue"))) {
    valid = addValidationError(errors, "childIssue must be a positive integer");
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "sourceCommitSha"))) {
    valid = addValidationError(errors, "sourceCommitSha is invalid");
  }
  if (!isCodeTaskGitTreeSha(ownField(value, "sourceTreeSha")))
    valid = addValidationError(errors, "sourceTreeSha is invalid");
  return valid;
}

function acceptanceEvidenceHeaderFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  expectedKind:
    typeof CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND | typeof CODE_TASK_QUALIFICATION_MANIFEST_KIND,
  expectedSchemaVersion: typeof CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
): boolean {
  let valid = true;

  if (ownField(value, "kind") !== expectedKind) {
    valid = addValidationError(errors, `kind must be ${expectedKind}`);
  }
  if (ownField(value, "schemaVersion") !== expectedSchemaVersion) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  return sourceProvenanceFieldsAreValid(errors, value) && valid;
}

function contributionHeaderFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  return acceptanceEvidenceHeaderFieldsAreValid(
    errors,
    value,
    CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
    CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
  );
}

function contributionSalvageFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  const salvage = ownField(value, "salvage");
  valid =
    acceptanceArrayMembersAreValid(errors, salvage, "salvage", (row, index): boolean =>
      salvageFieldsAreValid(errors, row, `salvage[${String(index)}]`),
    ) && valid;
  return valid;
}

function contributionBodyFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  const scenarios = ownField(value, "scenarios");
  valid =
    acceptanceArrayMembersAreValid(errors, scenarios, "scenarios", (scenario, index): boolean =>
      scenarioFieldsAreValid(errors, scenario, `scenarios[${String(index)}]`),
    ) && valid;
  valid = contributionSalvageFieldsAreValid(errors, value) && valid;
  const knownLimitations = ownField(value, "knownLimitations");
  if (!isNoteArray(knownLimitations)) {
    valid = addValidationError(
      errors,
      "knownLimitations must be an array of bounded content-free notes",
    );
  }
  valid = cleanupFieldsAreValid(errors, ownField(value, "cleanup")) && valid;
  return valid;
}

function admitCodeTaskAcceptanceContribution(
  value: unknown,
  errors: string[],
): value is CodeTaskAcceptanceContributionV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "contribution must be an object");
  valid = [
    valid,
    validateCodeTaskOwnKeys(errors, value, CONTRIBUTION_KEYS, "contribution"),
    contributionHeaderFieldsAreValid(errors, value),
    contributionBodyFieldsAreValid(errors, value),
  ].every(Boolean);
  return valid;
}

export function validateCodeTaskAcceptanceContribution(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskAcceptanceContributionV1> {
  const errors: string[] = [];
  return admitCodeTaskAcceptanceContribution(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

export interface CodeTaskAcceptanceBinding {
  readonly epicIssue: number;
  readonly childIssue: number;
  readonly sourceCommitSha: string;
  readonly registeredScenarioIds: readonly string[];
  /** Scenario ids whose trusted descriptor assigns the production-functional evidence class. */
  readonly registeredProductionFunctionalScenarioIds?: readonly string[];
  /** Qualification-only flow identities. Contribution callers leave this absent. */
  readonly registeredQualificationFlows?: readonly CodeTaskQualificationFlowBindingV1[];
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
    // KEIKO-0833: contribution is a validated CodeTaskAcceptanceContributionV1; the "incomplete"
    // arm's residueCount is a required number by construction (see the type at line 145 and the
    // isPositiveInteger check at line 419), so the isNonNegativeInteger guard here was dead code
    // whose 0-fallback branch was unreachable.
    failures.push(`incomplete cleanup: ${String(contribution.cleanup.residueCount)} residues`);
  }
  return failures;
}

// ─── Qualification manifest (#3390) ────────────────────────────────────────────────
// Versioned sibling of CodeTaskAcceptanceContributionV1 above (issue #3390 correction 6): it
// reuses this file's closed vocabularies (evidence classes, platforms, scenario outcomes) and
// hardened validation primitives (isRecord, ownField, unknownKeys, factErrors) rather than
// standing up a second schema file. #3390 qualifies real-model journeys and real production-
// functional platform proofs; unlike the #2384 acceptance contribution, a qualification scenario
// also carries the provenance that produced it. A scripted double can establish regression
// coverage but never qualification. Production-functional provenance is valid only for the same
// evidence class, and blocked rows carry the closed reason naming the missing external input.
//
// The real-binary lane's ps/lsof egress sampling (scripts/run-code-task-real-binary.mjs) emits a
// `functional-not-platform-qualified` observation that is deliberately NOT added to
// CODE_TASK_EVIDENCE_CLASSES above: that vocabulary is shared with the #2384 acceptance
// contribution, and its length is pinned at packages/keiko-contracts/src/index.test.ts:839. A
// qualification scenario produced by that lane is instead recorded with `outcome: "blocked"` and a
// `blockedReason` naming the platform gap (e.g. "functional-not-platform-qualified: #2951"), never
// as a distinct evidence class value; `isOneOf` already rejects it as an `evidenceClass`.
//
// The manifest carries no `qualified`/`blocked`/`failed` field of its own: issue #3390 correction 6
// is explicit that the manifest-level verdict is derived by the validator, never producer-supplied.
// `codeTaskQualificationVerdictFor` below is that derivation, reused by
// scripts/check-coding-issue-journey-evidence.mjs so the rule lives in exactly one place.

export const CODE_TASK_QUALIFICATION_MANIFEST_KIND = "code-task-qualification-manifest";

export const CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION = 1;

/** Exact model-visible inventory required by the controlled journey rubric on OpenCode V2. */
export const CODE_TASK_QUALIFICATION_REQUIRED_TOOLS = Object.freeze([
  "question",
  "keiko_repository_search",
  "keiko_workspace_discover",
  "keiko_workspace_read",
  "keiko_changeset_edit",
  "keiko_verification",
  "keiko_git_status",
  "keiko_git_diff",
  "keiko_git_stage",
  "keiko_git_execute",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_ci_status",
] as const satisfies readonly string[]);

export const CODE_TASK_QUALIFICATION_PROVENANCES = Object.freeze([
  "real-model",
  "scripted",
  "production-functional",
] as const satisfies readonly string[]);

export const CODE_TASK_QUALIFICATION_VERDICTS = Object.freeze([
  "qualified",
  "blocked",
  "failed",
] as const satisfies readonly string[]);

export const CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND = "code-task-qualification-flow-evidence";

export const CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS = Object.freeze([
  "issue-accepted",
  "coding-task-started",
  "verified-commit",
  "pushed-head",
  "draft-pull-request",
  "required-checks-observed",
  "description-applied",
  "ready-for-review",
  "merge-observed",
  "issue-closure-observed",
] as const satisfies readonly string[]);

export type CodeTaskQualificationProvenance = (typeof CODE_TASK_QUALIFICATION_PROVENANCES)[number];
export type CodeTaskQualificationVerdict = (typeof CODE_TASK_QUALIFICATION_VERDICTS)[number];
export type CodeTaskQualificationFlowTransition =
  (typeof CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS)[number];

export interface CodeTaskQualificationFlowBindingV1 {
  readonly flowId: CodeTaskScenarioId;
  readonly ordinal: number;
  readonly repository: string;
  readonly issueNumber: number;
  readonly mode: CodingWorkbenchMode;
}

export interface CodeTaskQualificationRequiredChecksV1 {
  readonly observation: "observed";
  readonly headSha: CodeTaskGitCommitSha;
  readonly requirementsVersion: "1";
  /** Digest produced by assessGitCiFacts from the effective named/app-bound requirements. */
  readonly requirementsDigest: CodeTaskSha256Digest;
  readonly evidenceRef: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
}

export interface CodeTaskQualificationAuthorityObservationV1 {
  readonly requestedMode: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly approvalRequestCount: number;
  readonly approvalRequests: readonly CodeTaskQualificationApprovalRequestObservationV1[];
  readonly approvedProposalActions: readonly CodeTaskQualificationApprovedProposalObservationV1[];
  readonly toolInvocationCount: number;
  readonly effectStartedCount: number;
  readonly effectStartedTools: readonly CodeTaskQualificationEffectToolObservationV1[];
  readonly completedToolCount: number;
  readonly deniedToolCount: number;
  readonly failedToolCount: number;
  readonly otherToolCount: number;
}

export interface CodeTaskQualificationApprovalRequestObservationV1 {
  readonly actionClass: CodingWorkbenchActionClass;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly requestCount: number;
}

export type CodeTaskQualificationProposalActionKind =
  "git-stage" | "commit" | "push" | "pull-request";

export interface CodeTaskQualificationApprovedProposalObservationV1 {
  readonly actionKind: CodeTaskQualificationProposalActionKind;
  readonly approvalCount: number;
}

export interface CodeTaskQualificationEffectToolObservationV1 {
  readonly canonicalId: string;
  readonly contractVersion: number;
  readonly invocationCount: number;
}

export interface CodeTaskQualificationRubricReviewV1 {
  readonly reviewId: string;
  readonly reviewDigest: CodeTaskSha256Digest;
  readonly verdict: "approved";
  readonly flowId: CodeTaskScenarioId;
  readonly taskRunId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullRequestNumber: number;
  readonly pullRequestHeadSha: CodeTaskGitCommitSha;
  readonly sourceCommitSha: CodeTaskGitCommitSha;
  readonly rubricDigest: CodeTaskSha256Digest;
  readonly criteriaTotal: number;
  readonly criteriaPassed: number;
}

export type CodeTaskQualificationRubricReview = CodeTaskQualificationRubricReviewV1;

export interface CodeTaskQualificationStageReceiptV1 {
  readonly scenarioId: CodeTaskScenarioId;
  readonly receiptDigest: CodeTaskSha256Digest;
}

export interface CodeTaskQualificationFlowStageEvidenceV1 {
  readonly issueToPr: CodeTaskQualificationStageReceiptV1;
  readonly ciRepair: CodeTaskQualificationStageReceiptV1 | null;
  readonly description: CodeTaskQualificationStageReceiptV1;
  readonly markReady: CodeTaskQualificationStageReceiptV1;
  readonly governedMerge: CodeTaskQualificationStageReceiptV1;
}

export interface CodeTaskQualificationFlowSpendV1 {
  readonly budgetNanoUsd: number;
  readonly chargedDeltaNanoUsd: number;
  readonly cumulativeChargedNanoUsd: number;
  readonly remainingNanoUsd: number;
}

/** One completed controlled-repository flow. This is the exact artifact body written by the live
 * harness; digests and receipt metadata are added only when the manifest binds its bytes. */
export interface CodeTaskQualificationFlowArtifactV1 {
  readonly evidenceKind: typeof CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND;
  readonly schemaVersion: 1;
  readonly flowId: CodeTaskScenarioId;
  readonly ordinal: number;
  readonly repository: string;
  readonly issueReference: string;
  readonly issueNumber: number;
  readonly issueState: "closed";
  /** Provider-observed issue closure instant. */
  readonly issueClosedAt: CodeTaskIsoInstant;
  readonly mode: CodingWorkbenchMode;
  readonly taskRunId: string;
  readonly pullRequestReference: string;
  readonly pullRequestNumber: number;
  readonly pullRequestHeadSha: CodeTaskGitCommitSha;
  readonly pullRequestState: "merged";
  /** Provider-observed pull-request merge instant. */
  readonly pullRequestMergedAt: CodeTaskIsoInstant;
  readonly mergeCommitSha: CodeTaskGitCommitSha;
  readonly requiredChecks: CodeTaskQualificationRequiredChecksV1;
  readonly authorityObservation: CodeTaskQualificationAuthorityObservationV1;
  readonly rubricReview: CodeTaskQualificationRubricReviewV1;
  readonly stageEvidence: CodeTaskQualificationFlowStageEvidenceV1;
  readonly transitions: readonly CodeTaskQualificationFlowTransition[];
  readonly sourceCommitSha: CodeTaskGitCommitSha;
  /** Instant the product's journey observer produced the completed outcome. */
  readonly observedAt: CodeTaskIsoInstant;
  readonly spend: CodeTaskQualificationFlowSpendV1;
}

export interface CodeTaskQualificationFlowV1 extends CodeTaskQualificationFlowArtifactV1 {
  readonly platform: CodeTaskEvidencePlatform;
  readonly provenance: CodeTaskQualificationProvenance;
  readonly recordedAt: CodeTaskIsoInstant;
  readonly artifactDigest: CodeTaskSha256Digest;
  readonly receiptDigest: CodeTaskSha256Digest;
}

export interface CodeTaskQualificationScenarioV1 {
  readonly scenarioId: CodeTaskScenarioId;
  readonly evidenceClass: CodeTaskEvidenceClass;
  readonly platform: CodeTaskEvidencePlatform;
  readonly provenance: CodeTaskQualificationProvenance;
  readonly outcome: CodeTaskScenarioOutcome;
  readonly recordedAt: CodeTaskIsoInstant;
  /** Known exactly when `outcome` is "blocked"; absent for every other outcome. */
  readonly blockedReason: CodeTaskFact<string>;
  /** Digests of the produced evidence artifacts; content stays outside the manifest. */
  readonly artifactDigests: readonly CodeTaskSha256Digest[];
  readonly receiptDigest: CodeTaskFact<CodeTaskSha256Digest>;
}

export interface CodeTaskQualificationManifestV1 {
  readonly kind: typeof CODE_TASK_QUALIFICATION_MANIFEST_KIND;
  readonly schemaVersion: typeof CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION;
  readonly epicIssue: number;
  readonly childIssue: number;
  readonly sourceCommitSha: CodeTaskGitCommitSha;
  readonly sourceTreeSha: CodeTaskGitTreeSha;
  /** Bounded content-free identifiers; never a prompt, endpoint, or credential. */
  readonly runtimeIdentity: string;
  readonly modelIdentity: string;
  readonly fixtureRevision: string;
  readonly rubricDigest: CodeTaskSha256Digest;
  /** Opaque GitHub facts; unknown/absent before the corresponding effect exists. */
  readonly issueReference: CodeTaskFact<string>;
  readonly pullRequestReference: CodeTaskFact<string>;
  readonly runReference: CodeTaskFact<string>;
  /** #3388's exact-head readiness snapshot, referenced by digest, never reimplemented here. */
  readonly readinessSnapshotDigest: CodeTaskFact<CodeTaskSha256Digest>;
  /** #3389's merge/closure reconciliation record, referenced by digest, never reimplemented here. */
  readonly journeyOutcomeDigest: CodeTaskFact<CodeTaskSha256Digest>;
  /** keiko-issue-audit runs outside this repository (issue #3390 correction 7); only its binding
   * is carried here -- the validator checks the binding and never executes or reproduces it. */
  readonly auditReference: CodeTaskFact<string>;
  readonly auditDigest: CodeTaskFact<CodeTaskSha256Digest>;
  /** Human merge/closure attestation (issue #3390 contract-correction 5): supplements, and can
   * never replace, #3389's machine-observed merge/closure facts referenced by
   * `journeyOutcomeDigest`. Required to be "known" whenever `journeyOutcomeDigest` is known --
   * this manifest cannot itself see whether that referenced outcome claims merged/closed, so the
   * fail-closed rule asks for the attestation whenever the outcome digest exists at all. */
  readonly humanMergeAttestationDigest: CodeTaskFact<CodeTaskSha256Digest>;
  /** Catalog tool names (issue #3390 contract-correction 4) the controlled fixture's rubric
   * requires; content-free by construction (a name, never a prompt or result). The evidence gate
   * rejects any entry absent from the model-visible tool set on the head under qualification. */
  readonly requiredTools: readonly string[];
  /** The operator-approved bounded evaluation budget the run was launched with (#3390 audit F15;
   * issue #3390: "Do not provision paid resources ... spend beyond operator-approved evaluation
   * budgets"). Always known -- the run cannot start without it (see
   * `resolveCodingIssueJourneyQualificationConfig`). */
  readonly spendBudgetUsd: number;
  /** What the model gateway actually reported spending; `unknown` when the gateway does not
   * report spend at all (never fabricated as zero). The validator flags overspend after the fact
   * by comparing this against `spendBudgetUsd` -- the budget is checked, not merely recorded. */
  readonly observedSpendUsd: CodeTaskFact<number>;
  readonly scenarios: readonly CodeTaskQualificationScenarioV1[];
  /** Five independently byte-bound, completed Issue -> task -> PR -> merge -> closed flows. */
  readonly flows: readonly CodeTaskQualificationFlowV1[];
  readonly knownLimitations: readonly string[];
}

const QUALIFICATION_SCENARIO_KEYS = [
  "scenarioId",
  "evidenceClass",
  "platform",
  "provenance",
  "outcome",
  "recordedAt",
  "blockedReason",
  "artifactDigests",
  "receiptDigest",
] as const;

const QUALIFICATION_FLOW_ARTIFACT_KEYS = [
  "evidenceKind",
  "schemaVersion",
  "flowId",
  "ordinal",
  "repository",
  "issueReference",
  "issueNumber",
  "issueState",
  "issueClosedAt",
  "mode",
  "taskRunId",
  "pullRequestReference",
  "pullRequestNumber",
  "pullRequestHeadSha",
  "pullRequestState",
  "pullRequestMergedAt",
  "mergeCommitSha",
  "requiredChecks",
  "authorityObservation",
  "rubricReview",
  "stageEvidence",
  "transitions",
  "sourceCommitSha",
  "observedAt",
  "spend",
] as const;

const QUALIFICATION_FLOW_KEYS = [
  ...QUALIFICATION_FLOW_ARTIFACT_KEYS,
  "platform",
  "provenance",
  "recordedAt",
  "artifactDigest",
  "receiptDigest",
] as const;

const QUALIFICATION_REQUIRED_CHECK_KEYS = [
  "observation",
  "headSha",
  "requirementsVersion",
  "requirementsDigest",
  "evidenceRef",
  "total",
  "passed",
  "failed",
  "pending",
] as const;

const QUALIFICATION_AUTHORITY_OBSERVATION_KEYS = [
  "requestedMode",
  "effectiveMode",
  "approvalRequestCount",
  "approvalRequests",
  "approvedProposalActions",
  "toolInvocationCount",
  "effectStartedCount",
  "effectStartedTools",
  "completedToolCount",
  "deniedToolCount",
  "failedToolCount",
  "otherToolCount",
] as const;

const QUALIFICATION_AUTHORITY_COUNT_KEYS = [
  "approvalRequestCount",
  "toolInvocationCount",
  "effectStartedCount",
  "completedToolCount",
  "deniedToolCount",
  "failedToolCount",
  "otherToolCount",
] as const;

const QUALIFICATION_APPROVAL_REQUEST_KEYS = ["actionClass", "actionKind", "requestCount"] as const;

const QUALIFICATION_APPROVED_PROPOSAL_KEYS = ["actionKind", "approvalCount"] as const;

const QUALIFICATION_EFFECT_TOOL_KEYS = [
  "canonicalId",
  "contractVersion",
  "invocationCount",
] as const;
const QUALIFICATION_PROPOSAL_ACTION_KINDS = [
  "git-stage",
  "commit",
  "push",
  "pull-request",
] as const;
const CANONICAL_TOOL_ID_PATTERN = /^[a-z][a-z0-9.-]{2,127}$/u;

const QUALIFICATION_RUBRIC_REVIEW_KEYS = [
  "reviewId",
  "reviewDigest",
  "verdict",
  "flowId",
  "taskRunId",
  "repository",
  "issueNumber",
  "pullRequestNumber",
  "pullRequestHeadSha",
  "sourceCommitSha",
  "rubricDigest",
  "criteriaTotal",
  "criteriaPassed",
] as const;

const QUALIFICATION_FLOW_STAGE_EVIDENCE_KEYS = [
  "issueToPr",
  "ciRepair",
  "description",
  "markReady",
  "governedMerge",
] as const;

const QUALIFICATION_STAGE_RECEIPT_KEYS = ["scenarioId", "receiptDigest"] as const;

const QUALIFICATION_FLOW_SPEND_KEYS = [
  "budgetNanoUsd",
  "chargedDeltaNanoUsd",
  "cumulativeChargedNanoUsd",
  "remainingNanoUsd",
] as const;

const QUALIFICATION_MODES = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
] as const;

const QUALIFICATION_MODE_SCENARIO_IDS: Readonly<Record<CodingWorkbenchMode, string>> = {
  "governed-assist": "issue-to-pr-governed-assist",
  "supervised-coding": "issue-to-pr-supervised-coding",
  "autonomous-delivery": "issue-to-pr-autonomous-delivery",
};

const QUALIFICATION_MANIFEST_KEYS = [
  "kind",
  "schemaVersion",
  "epicIssue",
  "childIssue",
  "sourceCommitSha",
  "sourceTreeSha",
  "runtimeIdentity",
  "modelIdentity",
  "fixtureRevision",
  "rubricDigest",
  "issueReference",
  "pullRequestReference",
  "runReference",
  "readinessSnapshotDigest",
  "journeyOutcomeDigest",
  "auditReference",
  "auditDigest",
  "humanMergeAttestationDigest",
  "requiredTools",
  "spendBudgetUsd",
  "observedSpendUsd",
  "scenarios",
  "flows",
  "knownLimitations",
] as const;

// Split out of qualificationScenarioErrors to keep that function's cyclomatic complexity under
// the repository ceiling: the blockedReason field has two cross-field rules of its own (known
// exactly when outcome is "blocked") on top of factErrors' own tagged-fact shape check.
function qualificationScenarioBlockedReasonFieldsAreValid(
  errors: string[],
  outcome: unknown,
  blockedReason: unknown,
  path: string,
): boolean {
  let valid = true;
  valid =
    factFieldsAreValid(errors, blockedReason, `${path}.blockedReason`, isCodeTaskContentFreeNote) &&
    valid;
  if (!isRecord(blockedReason)) return valid;
  const reasonOutcome = ownField(blockedReason, "outcome");
  if (outcome === "blocked" && reasonOutcome !== "known") {
    valid = addValidationError(
      errors,
      `${path}.blockedReason must be known when outcome is blocked`,
    );
  }
  if (outcome !== "blocked" && reasonOutcome === "known") {
    valid = addValidationError(
      errors,
      `${path}.blockedReason must not be known when outcome is not blocked`,
    );
  }
  return valid;
}

function qualificationScenarioArtifactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const artifactDigests = ownField(value, "artifactDigests");
  if (!isDigestArray(artifactDigests)) {
    valid = addValidationError(
      errors,
      `${path}.artifactDigests must be an array of sha256 digests`,
    );
  }
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "receiptDigest"),
      `${path}.receiptDigest`,
      isCodeTaskSha256Digest,
    ) && valid;
  return valid;
}

function qualificationScenarioIdentityFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  if (!isCodeTaskScenarioId(ownField(value, "scenarioId"))) {
    valid = addValidationError(errors, `${path}.scenarioId is invalid`);
  }
  if (!isOneOf(ownField(value, "evidenceClass"), CODE_TASK_EVIDENCE_CLASSES)) {
    valid = addValidationError(errors, `${path}.evidenceClass is not a registered evidence class`);
  }
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    valid = addValidationError(errors, `${path}.platform is not a supported evidence platform`);
  }
  if (!isOneOf(ownField(value, "provenance"), CODE_TASK_QUALIFICATION_PROVENANCES)) {
    valid = addValidationError(errors, `${path}.provenance is invalid`);
  }
  const outcome = ownField(value, "outcome");
  if (!isOneOf(outcome, CODE_TASK_SCENARIO_OUTCOMES)) {
    valid = addValidationError(errors, `${path}.outcome must be passed, failed, or blocked`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    valid = addValidationError(errors, `${path}.recordedAt must be an ISO-8601 UTC instant`);
  }
  valid =
    qualificationScenarioBlockedReasonFieldsAreValid(
      errors,
      outcome,
      ownField(value, "blockedReason"),
      path,
    ) && valid;
  valid = qualificationScenarioArtifactFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationScenarioFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, QUALIFICATION_SCENARIO_KEYS, path) && valid;
  valid = qualificationScenarioIdentityFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationRequiredCheckCountFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  for (const field of ["total", "passed", "failed", "pending"] as const) {
    const count = ownField(value, field);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      valid = addValidationError(errors, `${path}.${field} must be a non-negative integer`);
    }
  }
  return valid;
}

function qualificationRequiredCheckCompletionFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  const total = ownField(value, "total");
  const passed = ownField(value, "passed");
  const failed = ownField(value, "failed");
  const pending = ownField(value, "pending");
  if (
    typeof total === "number" &&
    typeof passed === "number" &&
    typeof failed === "number" &&
    typeof pending === "number" &&
    (total <= 0 || failed !== 0 || pending !== 0 || passed !== total)
  ) {
    return addValidationError(
      errors,
      `${path} must report one or more observed required checks passed`,
    );
  }
  return true;
}

function qualificationRequiredChecksFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = [
    valid,
    validateCodeTaskOwnKeys(errors, value, QUALIFICATION_REQUIRED_CHECK_KEYS, path),
    qualificationRequiredCheckCountFieldsAreValid(errors, value, path),
    qualificationRequiredCheckCompletionFieldsAreValid(errors, value, path),
  ].every(Boolean);
  if (ownField(value, "observation") !== "observed") {
    valid = addValidationError(errors, `${path}.observation must be observed`);
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "headSha"))) {
    valid = addValidationError(errors, `${path}.headSha is invalid`);
  }
  if (ownField(value, "requirementsVersion") !== "1") {
    valid = addValidationError(errors, `${path}.requirementsVersion must be 1`);
  }
  if (!isCodeTaskSha256Digest(ownField(value, "requirementsDigest"))) {
    valid = addValidationError(errors, `${path}.requirementsDigest is invalid`);
  }
  if (!isGitCiReadinessEvidenceRef(ownField(value, "evidenceRef"))) {
    valid = addValidationError(errors, `${path}.evidenceRef is invalid`);
  }
  return valid;
}

function qualificationNumericFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): boolean {
  let valid = true;
  for (const field of fields) {
    const amount = ownField(value, field);
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      valid = addValidationError(errors, `${path}.${field} must be a non-negative safe integer`);
    }
  }
  return valid;
}

function qualificationAuthorityObservationFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid =
    validateCodeTaskOwnKeys(errors, value, QUALIFICATION_AUTHORITY_OBSERVATION_KEYS, path) && valid;
  valid =
    qualificationNumericFieldsAreValid(errors, value, QUALIFICATION_AUTHORITY_COUNT_KEYS, path) &&
    valid;
  for (const field of ["requestedMode", "effectiveMode"] as const) {
    if (!isOneOf(ownField(value, field), QUALIFICATION_MODES)) {
      valid = addValidationError(errors, `${path}.${field} is invalid`);
    }
  }
  valid = [
    valid,
    qualificationApprovalRequestFieldsAreValid(errors, value, path),
    qualificationApprovedProposalFieldsAreValid(errors, value, path),
    qualificationEffectToolFieldsAreValid(errors, value, path),
    qualificationAuthorityCountFieldsAreValid(errors, value, path),
  ].every(Boolean);
  return valid;
}

function qualificationApprovalRequestFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const requests = ownField(value, "approvalRequests");
  if (!Array.isArray(requests))
    return addValidationError(errors, `${path}.approvalRequests must be an array`);

  const entries: readonly unknown[] = requests;
  valid =
    acceptanceMembersAreValid(
      errors,
      entries,
      `${path}.approvalRequests`,
      (request, index): boolean =>
        qualificationApprovalRequestMemberFieldsAreValid(errors, request, index, path),
    ) && valid;
  if (hasDuplicateObservedKeys(requests, ["actionClass", "actionKind"])) {
    valid = addValidationError(errors, `${path}.approvalRequests must group each action once`);
  }
  if (sumObservedCounts(requests, "requestCount") !== ownField(value, "approvalRequestCount"))
    valid = addValidationError(
      errors,
      `${path}.approvalRequests must account for approvalRequestCount`,
    );
  return valid;
}

function qualificationApprovedProposalFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const actions = ownField(value, "approvedProposalActions");
  if (!Array.isArray(actions))
    return addValidationError(errors, `${path}.approvedProposalActions must be an array`);

  const entries: readonly unknown[] = actions;
  valid =
    acceptanceMembersAreValid(
      errors,
      entries,
      `${path}.approvedProposalActions`,
      (action, index): boolean =>
        qualificationApprovedProposalMemberFieldsAreValid(errors, action, index, path),
    ) && valid;
  if (hasDuplicateObservedKeys(actions, ["actionKind"])) {
    valid = addValidationError(
      errors,
      `${path}.approvedProposalActions must group each action once`,
    );
  }
  return valid;
}

function qualificationEffectToolFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const tools = ownField(value, "effectStartedTools");
  if (!Array.isArray(tools))
    return addValidationError(errors, `${path}.effectStartedTools must be an array`);

  const entries: readonly unknown[] = tools;
  valid =
    acceptanceMembersAreValid(
      errors,
      entries,
      `${path}.effectStartedTools`,
      (tool, index): boolean =>
        qualificationEffectToolMemberFieldsAreValid(errors, tool, index, path),
    ) && valid;
  if (hasDuplicateObservedKeys(tools, ["canonicalId", "contractVersion"])) {
    valid = addValidationError(
      errors,
      `${path}.effectStartedTools must group each tool reference once`,
    );
  }
  if (sumObservedCounts(tools, "invocationCount") !== ownField(value, "effectStartedCount"))
    valid = addValidationError(
      errors,
      `${path}.effectStartedTools must account for effectStartedCount`,
    );
  return valid;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sumObservedCounts(values: readonly unknown[], field: string): number {
  return values.reduce<number>((sum, value) => {
    if (!isRecord(value)) return sum;
    const count = ownField(value, field);
    return positiveSafeInteger(count) ? sum + count : sum;
  }, 0);
}

function hasDuplicateObservedKeys(values: readonly unknown[], fields: readonly string[]): boolean {
  const keys = values
    .filter(isRecord)
    .map((value) => fields.map((field) => String(ownField(value, field))).join("\u0000"));
  return new Set(keys).size !== keys.length;
}

function qualificationAuthorityCountFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  if (invalidAuthorityAccounting(value)) {
    valid = addValidationError(
      errors,
      `${path} must account for one or more settled tool invocations`,
    );
  }
  if (requiresObservedApproval(value)) {
    valid = addValidationError(errors, `${path} must retain at least one approval request`);
  }
  if (nonPositiveObservedCount(value, "effectStartedCount")) {
    valid = addValidationError(errors, `${path} must retain at least one started effect`);
  }
  if (nonPositiveObservedCount(value, "completedToolCount")) {
    valid = addValidationError(
      errors,
      `${path} must retain at least one completed tool invocation`,
    );
  }
  if (startedEffectsExceedInvocations(value)) {
    valid = addValidationError(
      errors,
      `${path}.effectStartedCount cannot exceed toolInvocationCount`,
    );
  }
  if (approvedProposalsExceedRequests(value)) {
    valid = addValidationError(
      errors,
      `${path}.approvedProposalActions must match observed approval requests`,
    );
  }
  return valid;
}

function approvedProposalsExceedRequests(value: Record<string, unknown>): boolean {
  const requests = ownField(value, "approvalRequests");
  const approvals = ownField(value, "approvedProposalActions");
  if (!Array.isArray(requests) || !Array.isArray(approvals)) return false;
  const requestedCounts = new Map<string, number>();
  for (const request of requests) {
    if (!isRecord(request)) continue;
    const actionKind = ownField(request, "actionKind");
    const requestCount = ownField(request, "requestCount");
    if (typeof actionKind === "string" && positiveSafeInteger(requestCount)) {
      requestedCounts.set(actionKind, (requestedCounts.get(actionKind) ?? 0) + requestCount);
    }
  }
  return approvals.some((approval) => {
    if (!isRecord(approval)) return false;
    const actionKind = ownField(approval, "actionKind");
    const approvalCount = ownField(approval, "approvalCount");
    return (
      typeof actionKind === "string" &&
      positiveSafeInteger(approvalCount) &&
      approvalCount > (requestedCounts.get(actionKind) ?? 0)
    );
  });
}

function requiresObservedApproval(value: Record<string, unknown>): boolean {
  return (
    ownField(value, "requestedMode") !== "autonomous-delivery" &&
    nonPositiveObservedCount(value, "approvalRequestCount")
  );
}

function invalidAuthorityAccounting(value: Record<string, unknown>): boolean {
  const total = ownField(value, "toolInvocationCount");
  if (typeof total !== "number") return false;
  const outcomes = ["completedToolCount", "deniedToolCount", "failedToolCount", "otherToolCount"]
    .map((field) => ownField(value, field))
    .filter((count): count is number => typeof count === "number");
  if (outcomes.length !== 4) return false;
  return total <= 0 || outcomes.reduce((count, amount) => count + amount, 0) !== total;
}

function nonPositiveObservedCount(value: Record<string, unknown>, field: string): boolean {
  const count = ownField(value, field);
  return typeof count === "number" && count <= 0;
}

function startedEffectsExceedInvocations(value: Record<string, unknown>): boolean {
  const total = ownField(value, "toolInvocationCount");
  const effects = ownField(value, "effectStartedCount");
  return typeof total === "number" && typeof effects === "number" && effects > total;
}

function qualificationRubricReviewFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, QUALIFICATION_RUBRIC_REVIEW_KEYS, path) && valid;
  if (!isCodeTaskContentFreeNote(ownField(value, "reviewId"))) {
    valid = addValidationError(errors, `${path}.reviewId must be a bounded content-free reference`);
  }
  for (const field of ["reviewDigest", "rubricDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  if (ownField(value, "verdict") !== "approved")
    valid = addValidationError(errors, `${path}.verdict must be approved`);
  valid = qualificationRubricReviewIdentityFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationRubricReviewIdentityFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  if (!isCodeTaskScenarioId(ownField(value, "flowId")))
    valid = addValidationError(errors, `${path}.flowId is invalid`);
  if (!isCodeTaskContentFreeNote(ownField(value, "taskRunId"))) {
    valid = addValidationError(
      errors,
      `${path}.taskRunId must be a bounded content-free reference`,
    );
  }
  if (!GITHUB_REPOSITORY_PATTERN.test(String(ownField(value, "repository")))) {
    valid = addValidationError(errors, `${path}.repository is invalid`);
  }
  for (const field of [
    "issueNumber",
    "pullRequestNumber",
    "criteriaTotal",
    "criteriaPassed",
  ] as const) {
    if (!isPositiveInteger(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  for (const field of ["pullRequestHeadSha", "sourceCommitSha"] as const) {
    if (!isCodeTaskGitCommitSha(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  if (ownField(value, "criteriaPassed") !== ownField(value, "criteriaTotal")) {
    valid = addValidationError(errors, `${path} must report every independent criterion passed`);
  }
  return valid;
}

function qualificationStageReceiptFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
  expectedScenarioId: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, QUALIFICATION_STAGE_RECEIPT_KEYS, path) && valid;
  if (
    !isCodeTaskScenarioId(ownField(value, "scenarioId")) ||
    ownField(value, "scenarioId") !== expectedScenarioId
  ) {
    valid = addValidationError(errors, `${path}.scenarioId must be ${expectedScenarioId}`);
  }
  if (!isCodeTaskSha256Digest(ownField(value, "receiptDigest"))) {
    valid = addValidationError(errors, `${path}.receiptDigest is invalid`);
  }
  return valid;
}

function qualificationFlowStageEvidenceFieldsAreValid(
  errors: string[],
  value: unknown,
  flow: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  const mode = ownField(flow, "mode");
  const modeScenario = isOneOf(mode, QUALIFICATION_MODES)
    ? QUALIFICATION_MODE_SCENARIO_IDS[mode]
    : "invalid-mode";
  valid = [
    valid,
    validateCodeTaskOwnKeys(errors, value, QUALIFICATION_FLOW_STAGE_EVIDENCE_KEYS, path),
    qualificationStageReceiptFieldsAreValid(
      errors,
      ownField(value, "issueToPr"),
      `${path}.issueToPr`,
      modeScenario,
    ),
    qualificationStageReceiptFieldsAreValid(
      errors,
      ownField(value, "description"),
      `${path}.description`,
      "description-auto-draft-and-apply",
    ),
    qualificationStageReceiptFieldsAreValid(
      errors,
      ownField(value, "markReady"),
      `${path}.markReady`,
      "mark-ready-intent",
    ),
    qualificationStageReceiptFieldsAreValid(
      errors,
      ownField(value, "governedMerge"),
      `${path}.governedMerge`,
      "human-merge-and-closure",
    ),
  ].every(Boolean);
  valid = [
    valid,
    qualificationCiRepairStageFieldsAreValid(errors, value, path),
    qualificationStageDigestFieldsAreValid(errors, value, path),
  ].every(Boolean);
  return valid;
}

function qualificationCiRepairStageFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  const ciRepair = ownField(value, "ciRepair");
  return (
    ciRepair === null ||
    qualificationStageReceiptFieldsAreValid(errors, ciRepair, `${path}.ciRepair`, "ci-repair-loop")
  );
}

function qualificationStageDigestFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  const stages = QUALIFICATION_FLOW_STAGE_EVIDENCE_KEYS.map((key) => ownField(value, key)).filter(
    isRecord,
  );
  const digests = stages.map((stage) => ownField(stage, "receiptDigest"));
  return (
    (digests.every(isCodeTaskSha256Digest) && new Set(digests).size === digests.length) ||
    addValidationError(errors, `${path} must contain distinct stage receipt digests`)
  );
}

function qualificationFlowSpendBalanceFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const budget = ownField(value, "budgetNanoUsd");
  const cumulative = ownField(value, "cumulativeChargedNanoUsd");
  const remaining = ownField(value, "remainingNanoUsd");
  if (
    typeof budget === "number" &&
    typeof cumulative === "number" &&
    typeof remaining === "number" &&
    cumulative + remaining !== budget
  ) {
    valid = addValidationError(
      errors,
      `${path} cumulative charge plus remaining amount must equal budget`,
    );
  }
  return valid;
}

function qualificationFlowSpendFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, QUALIFICATION_FLOW_SPEND_KEYS, path) && valid;
  valid =
    qualificationNumericFieldsAreValid(errors, value, QUALIFICATION_FLOW_SPEND_KEYS, path) && valid;
  valid = qualificationFlowSpendBalanceFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationFlowUrlFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  const repository = ownField(value, "repository");
  const issueNumber = ownField(value, "issueNumber");
  const pullRequestNumber = ownField(value, "pullRequestNumber");
  if (typeof repository !== "string" || !GITHUB_REPOSITORY_PATTERN.test(repository)) {
    valid = addValidationError(errors, `${path}.repository must be a GitHub owner/name identity`);
  }
  if (
    typeof repository === "string" &&
    typeof issueNumber === "number" &&
    ownField(value, "issueReference") !==
      `https://github.com/${repository}/issues/${String(issueNumber)}`
  ) {
    valid = addValidationError(
      errors,
      `${path}.issueReference does not match repository and issueNumber`,
    );
  }
  if (
    typeof repository === "string" &&
    typeof pullRequestNumber === "number" &&
    ownField(value, "pullRequestReference") !==
      `https://github.com/${repository}/pull/${String(pullRequestNumber)}`
  ) {
    valid = addValidationError(
      errors,
      `${path}.pullRequestReference does not match repository and pullRequestNumber`,
    );
  }
  return valid;
}

function qualificationFlowReferenceFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  valid = qualificationFlowUrlFieldsAreValid(errors, value, path) && valid;
  for (const field of [
    "repository",
    "issueReference",
    "taskRunId",
    "pullRequestReference",
  ] as const) {
    if (!isCodeTaskContentFreeNote(ownField(value, field))) {
      valid = addValidationError(
        errors,
        `${path}.${field} must be a bounded content-free reference`,
      );
    }
  }
  return valid;
}

function qualificationFlowIdentityFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  valid = qualificationFlowReferenceFieldsAreValid(errors, value, path) && valid;
  if (!isCodeTaskScenarioId(ownField(value, "flowId")))
    valid = addValidationError(errors, `${path}.flowId is invalid`);
  if (!isPositiveInteger(ownField(value, "ordinal")))
    valid = addValidationError(errors, `${path}.ordinal is invalid`);
  if (!isPositiveInteger(ownField(value, "issueNumber"))) {
    valid = addValidationError(errors, `${path}.issueNumber is invalid`);
  }
  if (!isPositiveInteger(ownField(value, "pullRequestNumber"))) {
    valid = addValidationError(errors, `${path}.pullRequestNumber is invalid`);
  }
  if (!isOneOf(ownField(value, "mode"), QUALIFICATION_MODES)) {
    valid = addValidationError(errors, `${path}.mode is invalid`);
  }
  return valid;
}

function qualificationFlowTimestampFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  for (const field of ["issueClosedAt", "pullRequestMergedAt", "observedAt"] as const) {
    if (!isCodeTaskIsoInstant(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  const mergedAt = ownField(value, "pullRequestMergedAt");
  const closedAt = ownField(value, "issueClosedAt");
  const observedAt = ownField(value, "observedAt");
  if (
    isCodeTaskIsoInstant(mergedAt) &&
    isCodeTaskIsoInstant(closedAt) &&
    isCodeTaskIsoInstant(observedAt) &&
    (Date.parse(mergedAt) > Date.parse(closedAt) || Date.parse(closedAt) > Date.parse(observedAt))
  ) {
    valid = addValidationError(errors, `${path} lifecycle timestamps are out of causal order`);
  }
  return valid;
}

function qualificationFlowFinalEvidenceFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  const transitions = ownField(value, "transitions");
  if (!isQualificationTransitionArray(transitions)) {
    valid = addValidationError(
      errors,
      `${path}.transitions must contain the complete ordered qualification journey`,
    );
  }
  const checks = ownField(value, "requiredChecks");
  if (isRecord(checks) && ownField(checks, "headSha") !== ownField(value, "pullRequestHeadSha")) {
    valid = addValidationError(
      errors,
      `${path}.requiredChecks.headSha must match pullRequestHeadSha`,
    );
  }
  valid = qualificationFlowEvidenceBindingFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationFlowCompletionFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  if (ownField(value, "issueState") !== "closed")
    valid = addValidationError(errors, `${path}.issueState must be closed`);
  if (ownField(value, "pullRequestState") !== "merged") {
    valid = addValidationError(errors, `${path}.pullRequestState must be merged`);
  }
  valid = qualificationFlowTimestampFieldsAreValid(errors, value, path) && valid;
  for (const field of ["pullRequestHeadSha", "mergeCommitSha", "sourceCommitSha"] as const) {
    if (!isCodeTaskGitCommitSha(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  valid = [
    valid,
    qualificationRequiredChecksFieldsAreValid(
      errors,
      ownField(value, "requiredChecks"),
      `${path}.requiredChecks`,
    ),
    qualificationAuthorityObservationFieldsAreValid(
      errors,
      ownField(value, "authorityObservation"),
      `${path}.authorityObservation`,
    ),
    qualificationRubricReviewFieldsAreValid(
      errors,
      ownField(value, "rubricReview"),
      `${path}.rubricReview`,
    ),
    qualificationFlowStageEvidenceFieldsAreValid(
      errors,
      ownField(value, "stageEvidence"),
      value,
      `${path}.stageEvidence`,
    ),
    qualificationFlowSpendFieldsAreValid(errors, ownField(value, "spend"), `${path}.spend`),
  ].every(Boolean);
  valid = qualificationFlowFinalEvidenceFieldsAreValid(errors, value, path) && valid;
  return valid;
}

function qualificationFlowEvidenceBindingFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;

  const authority = ownField(value, "authorityObservation");
  if (
    isRecord(authority) &&
    (ownField(authority, "requestedMode") !== ownField(value, "mode") ||
      ownField(authority, "effectiveMode") !== ownField(value, "mode"))
  ) {
    valid = addValidationError(
      errors,
      `${path}.authorityObservation must match the selected mode without escalation`,
    );
  }
  const review = ownField(value, "rubricReview");
  if (!isRecord(review)) return valid;
  const bindings = [
    ["flowId", "flowId"],
    ["taskRunId", "taskRunId"],
    ["repository", "repository"],
    ["issueNumber", "issueNumber"],
    ["pullRequestNumber", "pullRequestNumber"],
    ["pullRequestHeadSha", "pullRequestHeadSha"],
    ["sourceCommitSha", "sourceCommitSha"],
  ] as const;
  if (bindings.some(([reviewField, flowField]) => review[reviewField] !== value[flowField])) {
    valid = addValidationError(
      errors,
      `${path}.rubricReview must match the completed flow identity`,
    );
  }
  return valid;
}

function qualificationFlowArtifactFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
  allowedKeys: readonly string[] = QUALIFICATION_FLOW_ARTIFACT_KEYS,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, value, allowedKeys, path) && valid;
  if (ownField(value, "evidenceKind") !== CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND) {
    valid = addValidationError(errors, `${path}.evidenceKind is invalid`);
  }
  if (ownField(value, "schemaVersion") !== 1)
    valid = addValidationError(errors, `${path}.schemaVersion must be 1`);
  valid = [
    valid,
    qualificationFlowIdentityFieldsAreValid(errors, value, path),
    qualificationFlowCompletionFieldsAreValid(errors, value, path),
  ].every(Boolean);
  return valid;
}

function qualificationFlowFieldsAreValid(errors: string[], value: unknown, path: string): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be an object`);
  valid =
    qualificationFlowArtifactFieldsAreValid(errors, value, path, QUALIFICATION_FLOW_KEYS) && valid;
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    valid = addValidationError(errors, `${path}.platform is invalid`);
  }
  if (ownField(value, "provenance") !== "real-model") {
    valid = addValidationError(errors, `${path}.provenance must be real-model`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    valid = addValidationError(errors, `${path}.recordedAt is invalid`);
  }
  for (const field of ["artifactDigest", "receiptDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, field)))
      valid = addValidationError(errors, `${path}.${field} is invalid`);
  }
  return valid;
}

function admitCodeTaskQualificationFlowArtifact(
  value: unknown,
  errors: string[],
): value is CodeTaskQualificationFlowArtifactV1 {
  let valid = true;
  valid = qualificationFlowArtifactFieldsAreValid(errors, value, "flowArtifact") && valid;
  return valid;
}

export function validateCodeTaskQualificationFlowArtifact(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskQualificationFlowArtifactV1> {
  const errors: string[] = [];
  return admitCodeTaskQualificationFlowArtifact(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function qualificationManifestHeaderFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  return acceptanceEvidenceHeaderFieldsAreValid(
    errors,
    value,
    CODE_TASK_QUALIFICATION_MANIFEST_KIND,
    CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
  );
}

// Split out of qualificationManifestBodyErrors to keep both functions under the repository's
// per-function line ceiling: this half owns the scalar identity/reference fields, the other half
// owns the scenarios array and knownLimitations.
function qualificationManifestAuditFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  return [
    factFieldsAreValid(
      errors,
      ownField(value, "auditReference"),
      "auditReference",
      isCodeTaskContentFreeNote,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "auditDigest"),
      "auditDigest",
      isCodeTaskSha256Digest,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "humanMergeAttestationDigest"),
      "humanMergeAttestationDigest",
      isCodeTaskSha256Digest,
    ),
  ].every(Boolean);
}

function qualificationManifestFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  valid = [
    valid,
    factFieldsAreValid(
      errors,
      ownField(value, "issueReference"),
      "issueReference",
      isCodeTaskContentFreeNote,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "pullRequestReference"),
      "pullRequestReference",
      isCodeTaskContentFreeNote,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "runReference"),
      "runReference",
      isCodeTaskContentFreeNote,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "readinessSnapshotDigest"),
      "readinessSnapshotDigest",
      isCodeTaskSha256Digest,
    ),
    factFieldsAreValid(
      errors,
      ownField(value, "journeyOutcomeDigest"),
      "journeyOutcomeDigest",
      isCodeTaskSha256Digest,
    ),
    qualificationManifestAuditFactFieldsAreValid(errors, value),
  ].every(Boolean);
  return valid;
}

function qualificationManifestReferenceFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;

  if (!isCodeTaskContentFreeNote(ownField(value, "runtimeIdentity"))) {
    valid = addValidationError(errors, "runtimeIdentity must be a bounded content-free reference");
  }
  if (!isCodeTaskContentFreeNote(ownField(value, "modelIdentity"))) {
    valid = addValidationError(errors, "modelIdentity must be a bounded content-free reference");
  }
  if (!isCodeTaskContentFreeNote(ownField(value, "fixtureRevision"))) {
    valid = addValidationError(errors, "fixtureRevision must be a bounded content-free reference");
  }
  if (!isCodeTaskSha256Digest(ownField(value, "rubricDigest"))) {
    valid = addValidationError(errors, "rubricDigest is invalid");
  }
  valid = qualificationManifestFactFieldsAreValid(errors, value) && valid;
  return valid;
}

function qualificationManifestRequiredToolsFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  const requiredTools = ownField(value, "requiredTools");
  if (!Array.isArray(requiredTools) || !requiredTools.every((tool) => isCodeTaskToolName(tool))) {
    return addValidationError(errors, "requiredTools must be an array of catalog tool names");
  }
  if (
    requiredTools.length !== CODE_TASK_QUALIFICATION_REQUIRED_TOOLS.length ||
    CODE_TASK_QUALIFICATION_REQUIRED_TOOLS.some(
      (expected, index) => requiredTools[index] !== expected,
    )
  ) {
    return addValidationError(
      errors,
      "requiredTools must exactly match the controlled-journey rubric inventory",
    );
  }
  return true;
}

// #3390 audit F15: the bounded evaluation budget the run was launched with, plus what the gateway
// actually reported spending. `spendBudgetUsd` is always a known positive amount by construction
// (the run cannot start without one); `observedSpendUsd` is a tagged fact because a gateway that
// does not report spend must never be recorded as having spent zero.
function qualificationManifestSpendFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;

  const spendBudgetUsd = ownField(value, "spendBudgetUsd");
  if (!isNonNegativeAmountUsd(spendBudgetUsd) || spendBudgetUsd <= 0) {
    valid = addValidationError(errors, "spendBudgetUsd must be a positive, bounded USD amount");
  }
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "observedSpendUsd"),
      "observedSpendUsd",
      isNonNegativeAmountUsd,
    ) && valid;
  return valid;
}

function qualificationManifestFlowsFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  const flows = ownField(value, "flows");
  valid =
    acceptanceArrayMembersAreValid(errors, flows, "flows", (flow, index): boolean =>
      qualificationFlowFieldsAreValid(errors, flow, `flows[${String(index)}]`),
    ) && valid;
  return valid;
}

function qualificationManifestBodyFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  valid = [
    valid,
    qualificationManifestReferenceFieldsAreValid(errors, value),
    qualificationManifestRequiredToolsFieldsAreValid(errors, value),
    qualificationManifestSpendFieldsAreValid(errors, value),
  ].every(Boolean);
  const scenarios = ownField(value, "scenarios");
  valid =
    acceptanceArrayMembersAreValid(errors, scenarios, "scenarios", (scenario, index): boolean =>
      qualificationScenarioFieldsAreValid(errors, scenario, `scenarios[${String(index)}]`),
    ) && valid;
  valid = qualificationManifestFlowsFieldsAreValid(errors, value) && valid;
  const knownLimitations = ownField(value, "knownLimitations");
  if (!isNoteArray(knownLimitations)) {
    valid = addValidationError(
      errors,
      "knownLimitations must be an array of bounded content-free notes",
    );
  }
  return valid;
}

function admitCodeTaskQualificationManifest(
  value: unknown,
  errors: string[],
): value is CodeTaskQualificationManifestV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "manifest must be an object");
  valid = [
    valid,
    validateCodeTaskOwnKeys(errors, value, QUALIFICATION_MANIFEST_KEYS, "manifest"),
    qualificationManifestHeaderFieldsAreValid(errors, value),
    qualificationManifestBodyFieldsAreValid(errors, value),
  ].every(Boolean);
  return valid;
}

export function validateCodeTaskQualificationManifest(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskQualificationManifestV1> {
  const errors: string[] = [];
  return admitCodeTaskQualificationManifest(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function scenarioRegistrationFailure(
  scenario: CodeTaskQualificationScenarioV1,
  registeredScenarioIds: ReadonlySet<string>,
): string | undefined {
  return registeredScenarioIds.has(scenario.scenarioId)
    ? undefined
    : `unregistered scenario: ${scenario.scenarioId}`;
}

function scenarioBlockedReasonFailure(
  scenario: CodeTaskQualificationScenarioV1,
): string | undefined {
  return scenario.outcome === "blocked" && scenario.blockedReason.outcome !== "known"
    ? `blocked scenario missing reason: ${scenario.scenarioId}`
    : undefined;
}

// The three ways a "passed" verdict can rest on provenance the manifest must not trust: a
// scripted double, an untrusted production-functional claim, and -- generalizing the same
// evidence-presence rule externalAuditDigestFailures already applies to the single hardcoded
// "keiko-issue-audit" scenario id -- a real-model claim carrying zero verification evidence
// (no artifact digest and no known receipt digest). Structurally valid, substantively empty.
function scenarioProvenanceFailure(
  scenario: CodeTaskQualificationScenarioV1,
  registeredProductionFunctionalScenarioIds: ReadonlySet<string>,
): string | undefined {
  if (scenario.outcome !== "passed") return undefined;
  if (scenario.provenance === "scripted") {
    return `scripted-model provenance cannot establish qualification: ${scenario.scenarioId}`;
  }
  if (
    scenario.provenance === "production-functional" &&
    (scenario.evidenceClass !== "production-functional" ||
      !registeredProductionFunctionalScenarioIds.has(scenario.scenarioId))
  ) {
    return `production-functional provenance is not trusted for scenario: ${scenario.scenarioId}`;
  }
  if (
    scenario.provenance === "real-model" &&
    scenario.artifactDigests.length === 0 &&
    scenario.receiptDigest.outcome !== "known"
  ) {
    return `passed real-model scenario carries no verification evidence: ${scenario.scenarioId}`;
  }
  return undefined;
}

// Split out of codeTaskQualificationManifestFailures to keep that function's cyclomatic
// complexity under the repository ceiling: these are the per-scenario rules, evaluated once per
// entry in the loop below.
function scenarioQualificationFailures(
  scenario: CodeTaskQualificationScenarioV1,
  registeredScenarioIds: ReadonlySet<string>,
  registeredProductionFunctionalScenarioIds: ReadonlySet<string>,
): readonly string[] {
  return [
    scenarioRegistrationFailure(scenario, registeredScenarioIds),
    scenarioBlockedReasonFailure(scenario),
    scenarioProvenanceFailure(scenario, registeredProductionFunctionalScenarioIds),
  ].filter((failure): failure is string => failure !== undefined);
}

// #3390 audit F3: a manifest that omits a required scenario entirely (rather than reporting it as
// failed or blocked) previously passed unnoticed -- the per-scenario loop only ever validates
// scenarios the manifest DOES carry. Every id the binding declares required must actually be
// present, not merely absent from complaints.
function missingRequiredScenarioFailures(
  manifest: CodeTaskQualificationManifestV1,
  binding: CodeTaskAcceptanceBinding,
): readonly string[] {
  const present = new Set<string>(manifest.scenarios.map((scenario) => scenario.scenarioId));
  return binding.registeredScenarioIds
    .filter((requiredId) => !present.has(requiredId))
    .map((requiredId) => `missing required scenario: ${requiredId}`);
}

function duplicateFlowIdentityFailures(
  flows: readonly CodeTaskQualificationFlowV1[],
): readonly string[] {
  const failures: string[] = [];
  const fields = [
    "flowId",
    "ordinal",
    "issueReference",
    "taskRunId",
    "pullRequestReference",
    "mergeCommitSha",
  ] as const;
  for (const field of fields) {
    const values = flows.map((flow) => flow[field]);
    if (new Set(values).size !== values.length) failures.push(`duplicate flow ${field}`);
  }
  return failures;
}

function flowBindingFailures(
  flows: readonly CodeTaskQualificationFlowV1[],
  expected: readonly CodeTaskQualificationFlowBindingV1[],
): readonly string[] {
  const failures: string[] = [];
  if (flows.length !== expected.length) {
    failures.push(
      `expected ${String(expected.length)} qualification flows, got ${String(flows.length)}`,
    );
  }
  for (const [index, binding] of expected.entries()) {
    const flow = flows[index];
    if (flow === undefined) continue;
    for (const field of ["flowId", "ordinal", "repository", "issueNumber", "mode"] as const) {
      if (flow[field] !== binding[field]) {
        failures.push(`qualification flow ${String(index + 1)} has foreign ${field}`);
      }
    }
  }
  return failures;
}

function flowSpendSequenceFailures(
  flows: readonly CodeTaskQualificationFlowV1[],
  spendBudgetUsd: number,
): readonly string[] {
  const failures: string[] = [];
  const budgetNanoUsd = Math.round(spendBudgetUsd * 1_000_000_000);
  let priorCumulative = 0;
  for (const flow of flows) {
    if (flow.spend.budgetNanoUsd !== budgetNanoUsd) {
      failures.push(`${flow.flowId}: flow budget does not match manifest budget`);
    }
    if (flow.spend.cumulativeChargedNanoUsd !== priorCumulative + flow.spend.chargedDeltaNanoUsd) {
      failures.push(`${flow.flowId}: charged delta does not bridge the prior ledger cumulative`);
    }
    priorCumulative = flow.spend.cumulativeChargedNanoUsd;
  }
  return failures;
}

function flowSummaryReferenceFailures(
  manifest: CodeTaskQualificationManifestV1,
): readonly string[] {
  const firstFlow = manifest.flows[0];
  if (firstFlow === undefined) return [];
  const matches =
    manifest.issueReference.outcome === "known" &&
    manifest.issueReference.value === firstFlow.issueReference &&
    manifest.pullRequestReference.outcome === "known" &&
    manifest.pullRequestReference.value === firstFlow.pullRequestReference &&
    manifest.runReference.outcome === "known" &&
    manifest.runReference.value === firstFlow.taskRunId;
  return matches ? [] : ["manifest journey references must identify the first qualification flow"];
}

function qualificationFlowFailures(
  manifest: CodeTaskQualificationManifestV1,
  binding: CodeTaskAcceptanceBinding,
): readonly string[] {
  const expected = binding.registeredQualificationFlows ?? [];
  const failures = [
    ...flowBindingFailures(manifest.flows, expected),
    ...duplicateFlowIdentityFailures(manifest.flows),
    ...flowSpendSequenceFailures(manifest.flows, manifest.spendBudgetUsd),
    ...flowSummaryReferenceFailures(manifest),
  ];
  for (const flow of manifest.flows) {
    if (flow.sourceCommitSha !== manifest.sourceCommitSha) {
      failures.push(`${flow.flowId}: stale or foreign flow source SHA binding`);
    }
    if (flow.rubricReview.rubricDigest !== manifest.rubricDigest) {
      failures.push(`${flow.flowId}: rubric review does not match manifest rubric digest`);
    }
  }
  const finalFlow = manifest.flows.at(-1);
  if (
    finalFlow !== undefined &&
    (manifest.observedSpendUsd.outcome !== "known" ||
      Math.round(manifest.observedSpendUsd.value * 1_000_000_000) !==
        finalFlow.spend.cumulativeChargedNanoUsd)
  ) {
    failures.push("observedSpendUsd must equal the final flow ledger cumulative");
  }
  return failures;
}

// #3390 audit F9 / issue #3390 contract-correction 5: a human merge attestation supplements
// #3389's machine-observed merge/closure facts and can never replace them, but the manifest cannot
// itself see whether the referenced journey outcome claims merged/closed -- it only holds an
// opaque digest. Requiring the attestation whenever the outcome digest is known (not only when it
// is known to claim merged/closed) is the fail-closed reading: an unattested merge/closure can
// never slip through because the manifest could not tell the two cases apart.
//
// #3390 audit F15: the approved evaluation budget is checked, not merely recorded -- an observed
// spend above it is a qualification failure, never a silent overage.
function externalAuditFactPairFailures(
  referenceKnown: boolean,
  digestKnown: boolean,
): readonly string[] {
  return referenceKnown === digestKnown
    ? []
    : ["external audit reference and digest must both be known"];
}

function externalAuditScenarioFactFailures(
  scenario: CodeTaskQualificationScenarioV1 | undefined,
  factsKnown: boolean,
): readonly string[] {
  if (scenario === undefined) {
    return factsKnown ? ["external audit facts require the external audit scenario"] : [];
  }
  if (scenario.outcome === "passed" && !factsKnown) {
    return ["passed external audit requires a known reference and digest"];
  }
  if (scenario.outcome === "blocked" && factsKnown) {
    return ["blocked external audit cannot carry completed audit facts"];
  }
  return [];
}

function externalAuditPassedEvidenceFailures(
  scenario: CodeTaskQualificationScenarioV1 | undefined,
): readonly string[] {
  if (scenario?.outcome !== "passed") return [];
  return scenario.evidenceClass === "production-functional" &&
    scenario.provenance === "production-functional"
    ? []
    : ["passed external audit requires production-functional evidence provenance"];
}

function externalAuditDigestFailures(
  scenario: CodeTaskQualificationScenarioV1 | undefined,
  auditDigest: CodeTaskFact<CodeTaskSha256Digest>,
): readonly string[] {
  if (auditDigest.outcome !== "known" || scenario?.receiptDigest.outcome !== "known") return [];
  return auditDigest.value === scenario.receiptDigest.value
    ? []
    : ["external audit digest must match its receipt artifact digest"];
}

function externalAuditBindingFailures(
  manifest: CodeTaskQualificationManifestV1,
): readonly string[] {
  const scenario = manifest.scenarios.find(({ scenarioId }) => scenarioId === "keiko-issue-audit");
  const referenceKnown = manifest.auditReference.outcome === "known";
  const digestKnown = manifest.auditDigest.outcome === "known";
  return [
    ...externalAuditFactPairFailures(referenceKnown, digestKnown),
    ...externalAuditScenarioFactFailures(scenario, referenceKnown && digestKnown),
    ...externalAuditPassedEvidenceFailures(scenario),
    ...externalAuditDigestFailures(scenario, manifest.auditDigest),
  ];
}

function manifestCrossFieldFailures(manifest: CodeTaskQualificationManifestV1): readonly string[] {
  const failures: string[] = [...externalAuditBindingFailures(manifest)];
  if (
    manifest.journeyOutcomeDigest.outcome === "known" &&
    manifest.humanMergeAttestationDigest.outcome !== "known"
  ) {
    failures.push("humanMergeAttestationDigest required when journeyOutcomeDigest is known");
  }
  if (
    manifest.observedSpendUsd.outcome === "known" &&
    manifest.observedSpendUsd.value > manifest.spendBudgetUsd
  ) {
    failures.push(
      `spend budget exceeded: observed ${String(manifest.observedSpendUsd.value)} usd exceeds ` +
        `budget ${String(manifest.spendBudgetUsd)} usd`,
    );
  }
  return failures;
}

/**
 * Consumer-side qualification rules for #3390: a structurally valid manifest still fails to
 * qualify when it is empty, bound to a foreign or stale SHA, references an unregistered or missing
 * scenario, a blocked scenario carries no reason, a "passed" scenario is scripted rather than
 * real-model (a scripted double can only ever produce regression coverage, never qualification
 * evidence), a merged/closed journey outcome carries no human merge attestation, or the observed
 * spend exceeds the approved budget. Failures are content-free strings; the manifest itself carries
 * no producer-supplied verdict.
 */
export function codeTaskQualificationManifestFailures(
  manifest: CodeTaskQualificationManifestV1,
  binding: CodeTaskAcceptanceBinding,
): readonly string[] {
  const failures: string[] = [];
  if (manifest.scenarios.length === 0) {
    failures.push("empty manifest: at least one scenario is required");
  }
  if (manifest.epicIssue !== binding.epicIssue) failures.push("foreign epic issue binding");
  if (manifest.childIssue !== binding.childIssue) failures.push("foreign child issue binding");
  if (manifest.sourceCommitSha !== binding.sourceCommitSha) {
    failures.push("stale or foreign source SHA binding");
  }
  const registered = new Set(binding.registeredScenarioIds);
  const registeredProductionFunctional = new Set(
    binding.registeredProductionFunctionalScenarioIds ?? [],
  );
  for (const scenario of manifest.scenarios) {
    failures.push(
      ...scenarioQualificationFailures(scenario, registered, registeredProductionFunctional),
    );
  }
  failures.push(
    ...missingRequiredScenarioFailures(manifest, binding),
    ...qualificationFlowFailures(manifest, binding),
    ...manifestCrossFieldFailures(manifest),
  );
  return failures;
}

/**
 * Derives the manifest-level verdict; never a row value and never producer-supplied (issue #3390
 * correction 6). "failed" when any scenario failed outright; otherwise "blocked" when the binding
 * does not hold or the scenario set does not yet establish qualification (a missing/foreign
 * binding, an outstanding blocked scenario, or a "passed" claim resting on scripted provenance);
 * "qualified" only when the binding matches and every registered scenario is "passed" with
 * real-model provenance or matching production-functional evidence.
 */
export function codeTaskQualificationVerdictFor(
  manifest: CodeTaskQualificationManifestV1,
  binding: CodeTaskAcceptanceBinding,
): CodeTaskQualificationVerdict {
  if (manifest.scenarios.some((scenario) => scenario.outcome === "failed")) {
    return "failed";
  }
  if (codeTaskQualificationManifestFailures(manifest, binding).length > 0) {
    return "blocked";
  }
  const allQualified = manifest.scenarios.every(
    (scenario) =>
      scenario.outcome === "passed" &&
      (scenario.provenance === "real-model" ||
        (scenario.provenance === "production-functional" &&
          scenario.evidenceClass === "production-functional")),
  );
  return allQualified ? "qualified" : "blocked";
}

function qualificationApprovalRequestMemberFieldsAreValid(
  errors: string[],
  request: unknown,
  index: number,
  path: string,
): boolean {
  let valid = true;
  const itemPath = `${path}.approvalRequests[${String(index)}]`;
  if (!isRecord(request)) return addValidationError(errors, `${itemPath} must be an object`);
  valid =
    validateCodeTaskOwnKeys(errors, request, QUALIFICATION_APPROVAL_REQUEST_KEYS, itemPath) &&
    valid;
  const actionClass = ownField(request, "actionClass");
  const actionKind = ownField(request, "actionKind");
  if (!isOneOf(actionClass, CODING_WORKBENCH_ACTION_CLASSES))
    valid = addValidationError(errors, `${itemPath}.actionClass is invalid`);
  if (!isOneOf(actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS))
    valid = addValidationError(errors, `${itemPath}.actionKind is invalid`);
  if (
    isOneOf(actionClass, CODING_WORKBENCH_ACTION_CLASSES) &&
    isOneOf(actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS) &&
    permissionKindForSupervisedCodingAction(actionKind) !== actionClass
  ) {
    valid = addValidationError(errors, `${itemPath} actionClass does not match actionKind`);
  }
  if (!positiveSafeInteger(ownField(request, "requestCount")))
    valid = addValidationError(errors, `${itemPath}.requestCount must be a positive safe integer`);
  return valid;
}

function qualificationApprovedProposalMemberFieldsAreValid(
  errors: string[],
  action: unknown,
  index: number,
  path: string,
): boolean {
  let valid = true;
  const itemPath = `${path}.approvedProposalActions[${String(index)}]`;
  if (!isRecord(action)) return addValidationError(errors, `${itemPath} must be an object`);
  valid =
    validateCodeTaskOwnKeys(errors, action, QUALIFICATION_APPROVED_PROPOSAL_KEYS, itemPath) &&
    valid;
  if (!isOneOf(ownField(action, "actionKind"), QUALIFICATION_PROPOSAL_ACTION_KINDS))
    valid = addValidationError(errors, `${itemPath}.actionKind is invalid`);
  if (!positiveSafeInteger(ownField(action, "approvalCount")))
    valid = addValidationError(errors, `${itemPath}.approvalCount must be a positive safe integer`);
  return valid;
}

function qualificationEffectToolMemberFieldsAreValid(
  errors: string[],
  tool: unknown,
  index: number,
  path: string,
): boolean {
  let valid = true;
  const itemPath = `${path}.effectStartedTools[${String(index)}]`;
  if (!isRecord(tool)) return addValidationError(errors, `${itemPath} must be an object`);
  valid = validateCodeTaskOwnKeys(errors, tool, QUALIFICATION_EFFECT_TOOL_KEYS, itemPath) && valid;
  const canonicalId = ownField(tool, "canonicalId");
  if (typeof canonicalId !== "string" || !CANONICAL_TOOL_ID_PATTERN.test(canonicalId))
    valid = addValidationError(errors, `${itemPath}.canonicalId is invalid`);
  if (!positiveSafeInteger(ownField(tool, "contractVersion")))
    valid = addValidationError(
      errors,
      `${itemPath}.contractVersion must be a positive safe integer`,
    );
  if (!positiveSafeInteger(ownField(tool, "invocationCount")))
    valid = addValidationError(
      errors,
      `${itemPath}.invocationCount must be a positive safe integer`,
    );
  return valid;
}

function isDigestArray(value: unknown): value is readonly CodeTaskSha256Digest[] {
  if (!Array.isArray(value)) return false;
  const entries: readonly unknown[] = value;
  const length = entries.length;
  for (let index = 0; index < length; index += 1) {
    if (!isCodeTaskSha256Digest(entries[index])) return false;
  }
  return true;
}

function isNoteArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const entries: readonly unknown[] = value;
  const length = entries.length;
  for (let index = 0; index < length; index += 1) {
    if (!isCodeTaskContentFreeNote(entries[index])) return false;
  }
  return true;
}

function isQualificationTransitionArray(
  value: unknown,
): value is readonly CodeTaskQualificationFlowTransition[] {
  if (!Array.isArray(value) || value.length !== CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS.length)
    return false;
  const entries: readonly unknown[] = value;
  for (let index = 0; index < CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS.length; index += 1) {
    if (entries[index] !== CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS[index]) return false;
  }
  return true;
}
