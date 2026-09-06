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

/** A governed-tool catalog name (e.g. `keiko_changeset_edit`): content-free by construction, never
 * a prompt, argument, or result. */
export function isCodeTaskToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME_PATTERN.test(value);
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
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
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
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
export function hasInheritedEnumerableProperty(record: Record<string, unknown>): boolean {
  for (const key in record) {
    if (!Object.hasOwn(record, key)) return true;
  }
  return false;
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

function factErrors(
  value: unknown,
  path: string,
  isValue: (candidate: unknown) => boolean,
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be a tagged fact object`];
  if (hasInheritedEnumerableProperty(value)) {
    return [`${path} must not resolve any field through its prototype chain`];
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") {
    // Collected, not early-returned: an object can carry both an extra own key and an invalid
    // value, and both are worth reporting (KfQ 3789542365 raised this for the branch below; the
    // same shape applied here).
    const errors = unknownKeys(value, ["outcome", "value"], path);
    if (!isValue(ownField(value, "value"))) {
      errors.push(`${path}.value is invalid for a known fact`);
    }
    return errors;
  }
  if (outcome === "unknown" || outcome === "unavailable" || outcome === "absent") {
    // KfQ 3789542365: this used to return early on an own "value" field, so unknownKeys never ran
    // and any OTHER extra own key went unreported. Collected instead, matching the "report every
    // violation" position already taken for onlyKnownKeys elsewhere in this PR.
    const errors = unknownKeys(value, ["outcome"], path);
    if (Object.hasOwn(value, "value")) {
      errors.push(`${path} must not carry a value for outcome ${outcome}`);
    }
    return errors;
  }
  return [`${path}.outcome must be known, unknown, unavailable, or absent`];
}

// Closed key sets. Every peer validator in this territory enforces one and says why — an unexpected
// field on a documented content-free contract must never ride through into evidence. These four did
// not, so a payload could carry `promptText` (or any other free-text field) alongside the validated
// ones and be accepted, then be handed on as `value`. Mirrors code-task-governance.ts's unknownKeys.
// Object.getOwnPropertyNames (not Object.keys) plus an own-symbol check, matching
// debug/debug-lifecycle.ts's idiom for the same class of threat: Object.keys alone misses a
// non-enumerable own property; every caller here already passes through the hardened isRecord
// above, which is what actually closes the prototype case (see its own comment) that neither this
// nor debug-lifecycle.ts's own-property scan can see on its own.
function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  const errors = Object.getOwnPropertyNames(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    errors.push(`${path} must not carry symbol-keyed properties`);
  }
  return errors;
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
  if (!isCodeTaskScenarioId(ownField(value, "scenarioId"))) {
    errors.push(`${path}.scenarioId is invalid`);
  }
  if (!isOneOf(ownField(value, "evidenceClass"), CODE_TASK_EVIDENCE_CLASSES)) {
    errors.push(`${path}.evidenceClass is not a registered evidence class`);
  }
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    errors.push(`${path}.platform is not a supported evidence platform`);
  }
  if (!isOneOf(ownField(value, "outcome"), CODE_TASK_SCENARIO_OUTCOMES)) {
    errors.push(`${path}.outcome must be passed, failed, or blocked`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    errors.push(`${path}.recordedAt must be an ISO-8601 UTC instant`);
  }
  const artifactDigests = ownField(value, "artifactDigests");
  if (
    !Array.isArray(artifactDigests) ||
    !artifactDigests.every((digest) => isCodeTaskSha256Digest(digest))
  ) {
    errors.push(`${path}.artifactDigests must be an array of sha256 digests`);
  }
  errors.push(
    ...factErrors(
      ownField(value, "receiptDigest"),
      `${path}.receiptDigest`,
      isCodeTaskSha256Digest,
    ),
  );
  return errors;
}

function salvageErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [...unknownKeys(value, SALVAGE_KEYS, path)];
  if (!isCodeTaskContentFreeNote(ownField(value, "sourceBranch"))) {
    errors.push(`${path}.sourceBranch must be a bounded content-free reference`);
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "sourceSha"))) {
    errors.push(`${path}.sourceSha is invalid`);
  }
  if (!isCodeTaskRepoRelativePath(ownField(value, "path"))) {
    errors.push(`${path}.path must be a repo-relative path`);
  }
  if (!isOneOf(ownField(value, "disposition"), CODE_TASK_SALVAGE_DISPOSITIONS)) {
    errors.push(`${path}.disposition must be taken-verbatim, reshaped, or rejected`);
  }
  errors.push(
    ...factErrors(ownField(value, "reshaping"), `${path}.reshaping`, isCodeTaskContentFreeNote),
  );
  if (!isCodeTaskGitCommitSha(ownField(value, "verifiedAtSha"))) {
    errors.push(`${path}.verifiedAtSha is invalid`);
  }
  return errors;
}

function cleanupErrors(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["cleanup must be an object"];
  const unknownFieldErrors = unknownKeys(value, CLEANUP_KEYS, "cleanup");
  const state = ownField(value, "state");
  if (state === "complete") {
    // Was `"residueCount" in value` -- the `in` operator walks the prototype chain exactly like
    // plain property access does, so it has the identical inherited-field exposure ownField closes
    // elsewhere in this file. Object.hasOwn is the own-only equivalent.
    return Object.hasOwn(value, "residueCount")
      ? [...unknownFieldErrors, "cleanup.residueCount is only valid when incomplete"]
      : unknownFieldErrors;
  }
  if (state === "incomplete") {
    return isPositiveInteger(ownField(value, "residueCount"))
      ? unknownFieldErrors
      : [...unknownFieldErrors, "cleanup.residueCount must be a positive integer when incomplete"];
  }
  return [...unknownFieldErrors, "cleanup.state must be complete or incomplete"];
}

function contributionHeaderErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (ownField(value, "kind") !== CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND) {
    errors.push(`kind must be ${CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_ACCEPTANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isPositiveInteger(ownField(value, "epicIssue"))) {
    errors.push("epicIssue must be a positive integer");
  }
  if (!isPositiveInteger(ownField(value, "childIssue"))) {
    errors.push("childIssue must be a positive integer");
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "sourceCommitSha"))) {
    errors.push("sourceCommitSha is invalid");
  }
  if (!isCodeTaskGitTreeSha(ownField(value, "sourceTreeSha")))
    errors.push("sourceTreeSha is invalid");
  return errors;
}

function contributionBodyErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  const scenarios = ownField(value, "scenarios");
  if (Array.isArray(scenarios)) {
    scenarios.forEach((scenario, index) => {
      errors.push(...scenarioErrors(scenario, `scenarios[${String(index)}]`));
    });
  } else {
    errors.push("scenarios must be an array");
  }
  const salvage = ownField(value, "salvage");
  if (Array.isArray(salvage)) {
    salvage.forEach((row, index) => {
      errors.push(...salvageErrors(row, `salvage[${String(index)}]`));
    });
  } else {
    errors.push("salvage must be an array");
  }
  const knownLimitations = ownField(value, "knownLimitations");
  if (
    !Array.isArray(knownLimitations) ||
    !knownLimitations.every((note) => isCodeTaskContentFreeNote(note))
  ) {
    errors.push("knownLimitations must be an array of bounded content-free notes");
  }
  errors.push(...cleanupErrors(ownField(value, "cleanup")));
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

/** Exact model-visible inventory required by the controlled #3390 journey rubric. */
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
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_ci_status",
  "todowrite",
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
function qualificationScenarioBlockedReasonErrors(
  outcome: unknown,
  blockedReason: unknown,
  path: string,
): readonly string[] {
  const errors: string[] = [
    ...factErrors(blockedReason, `${path}.blockedReason`, isCodeTaskContentFreeNote),
  ];
  if (!isRecord(blockedReason)) return errors;
  const reasonOutcome = ownField(blockedReason, "outcome");
  if (outcome === "blocked" && reasonOutcome !== "known") {
    errors.push(`${path}.blockedReason must be known when outcome is blocked`);
  }
  if (outcome !== "blocked" && reasonOutcome === "known") {
    errors.push(`${path}.blockedReason must not be known when outcome is not blocked`);
  }
  return errors;
}

function qualificationScenarioErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [...unknownKeys(value, QUALIFICATION_SCENARIO_KEYS, path)];
  if (!isCodeTaskScenarioId(ownField(value, "scenarioId"))) {
    errors.push(`${path}.scenarioId is invalid`);
  }
  if (!isOneOf(ownField(value, "evidenceClass"), CODE_TASK_EVIDENCE_CLASSES)) {
    errors.push(`${path}.evidenceClass is not a registered evidence class`);
  }
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    errors.push(`${path}.platform is not a supported evidence platform`);
  }
  if (!isOneOf(ownField(value, "provenance"), CODE_TASK_QUALIFICATION_PROVENANCES)) {
    errors.push(`${path}.provenance is invalid`);
  }
  const outcome = ownField(value, "outcome");
  if (!isOneOf(outcome, CODE_TASK_SCENARIO_OUTCOMES)) {
    errors.push(`${path}.outcome must be passed, failed, or blocked`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    errors.push(`${path}.recordedAt must be an ISO-8601 UTC instant`);
  }
  errors.push(
    ...qualificationScenarioBlockedReasonErrors(outcome, ownField(value, "blockedReason"), path),
  );
  const artifactDigests = ownField(value, "artifactDigests");
  if (
    !Array.isArray(artifactDigests) ||
    !artifactDigests.every((digest) => isCodeTaskSha256Digest(digest))
  ) {
    errors.push(`${path}.artifactDigests must be an array of sha256 digests`);
  }
  errors.push(
    ...factErrors(
      ownField(value, "receiptDigest"),
      `${path}.receiptDigest`,
      isCodeTaskSha256Digest,
    ),
  );
  return errors;
}

function qualificationRequiredCheckCountErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  for (const field of ["total", "passed", "failed", "pending"] as const) {
    const count = ownField(value, field);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      errors.push(`${path}.${field} must be a non-negative integer`);
    }
  }
  return errors;
}

function qualificationRequiredCheckCompletionErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
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
    return [`${path} must report one or more observed required checks passed`];
  }
  return [];
}

function qualificationRequiredChecksErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [
    ...unknownKeys(value, QUALIFICATION_REQUIRED_CHECK_KEYS, path),
    ...qualificationRequiredCheckCountErrors(value, path),
    ...qualificationRequiredCheckCompletionErrors(value, path),
  ];
  if (ownField(value, "observation") !== "observed") {
    errors.push(`${path}.observation must be observed`);
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "headSha"))) {
    errors.push(`${path}.headSha is invalid`);
  }
  if (ownField(value, "requirementsVersion") !== "1") {
    errors.push(`${path}.requirementsVersion must be 1`);
  }
  if (!isCodeTaskSha256Digest(ownField(value, "requirementsDigest"))) {
    errors.push(`${path}.requirementsDigest is invalid`);
  }
  if (!isGitCiReadinessEvidenceRef(ownField(value, "evidenceRef"))) {
    errors.push(`${path}.evidenceRef is invalid`);
  }
  return errors;
}

function qualificationAuthorityObservationErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...unknownKeys(value, QUALIFICATION_AUTHORITY_OBSERVATION_KEYS, path)];
  for (const field of QUALIFICATION_AUTHORITY_COUNT_KEYS) {
    const count = ownField(value, field);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      errors.push(`${path}.${field} must be a non-negative safe integer`);
    }
  }
  for (const field of ["requestedMode", "effectiveMode"] as const) {
    if (!isOneOf(ownField(value, field), QUALIFICATION_MODES)) {
      errors.push(`${path}.${field} is invalid`);
    }
  }
  errors.push(
    ...qualificationApprovalRequestErrors(value, path),
    ...qualificationApprovedProposalErrors(value, path),
    ...qualificationEffectToolErrors(value, path),
  );
  errors.push(...qualificationAuthorityCountErrors(value, path));
  return errors;
}

function qualificationApprovalRequestErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const requests = ownField(value, "approvalRequests");
  if (!Array.isArray(requests)) return [`${path}.approvalRequests must be an array`];
  const errors = requests.flatMap((request, index) => {
    const itemPath = `${path}.approvalRequests[${String(index)}]`;
    if (!isRecord(request)) return [`${itemPath} must be an object`];
    const itemErrors = [...unknownKeys(request, QUALIFICATION_APPROVAL_REQUEST_KEYS, itemPath)];
    const actionClass = ownField(request, "actionClass");
    const actionKind = ownField(request, "actionKind");
    if (!isOneOf(actionClass, CODING_WORKBENCH_ACTION_CLASSES))
      itemErrors.push(`${itemPath}.actionClass is invalid`);
    if (!isOneOf(actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS))
      itemErrors.push(`${itemPath}.actionKind is invalid`);
    if (
      isOneOf(actionClass, CODING_WORKBENCH_ACTION_CLASSES) &&
      isOneOf(actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS) &&
      permissionKindForSupervisedCodingAction(actionKind) !== actionClass
    ) {
      itemErrors.push(`${itemPath} actionClass does not match actionKind`);
    }
    if (!positiveSafeInteger(ownField(request, "requestCount")))
      itemErrors.push(`${itemPath}.requestCount must be a positive safe integer`);
    return itemErrors;
  });
  if (hasDuplicateObservedKeys(requests, ["actionClass", "actionKind"])) {
    errors.push(`${path}.approvalRequests must group each action once`);
  }
  if (sumObservedCounts(requests, "requestCount") !== ownField(value, "approvalRequestCount"))
    errors.push(`${path}.approvalRequests must account for approvalRequestCount`);
  return errors;
}

function qualificationApprovedProposalErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const actions = ownField(value, "approvedProposalActions");
  if (!Array.isArray(actions)) return [`${path}.approvedProposalActions must be an array`];
  const errors = actions.flatMap((action, index) => {
    const itemPath = `${path}.approvedProposalActions[${String(index)}]`;
    if (!isRecord(action)) return [`${itemPath} must be an object`];
    const itemErrors = [...unknownKeys(action, QUALIFICATION_APPROVED_PROPOSAL_KEYS, itemPath)];
    if (!isOneOf(ownField(action, "actionKind"), QUALIFICATION_PROPOSAL_ACTION_KINDS))
      itemErrors.push(`${itemPath}.actionKind is invalid`);
    if (!positiveSafeInteger(ownField(action, "approvalCount")))
      itemErrors.push(`${itemPath}.approvalCount must be a positive safe integer`);
    return itemErrors;
  });
  if (hasDuplicateObservedKeys(actions, ["actionKind"])) {
    errors.push(`${path}.approvedProposalActions must group each action once`);
  }
  return errors;
}

function qualificationEffectToolErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const tools = ownField(value, "effectStartedTools");
  if (!Array.isArray(tools)) return [`${path}.effectStartedTools must be an array`];
  const errors = tools.flatMap((tool, index) => {
    const itemPath = `${path}.effectStartedTools[${String(index)}]`;
    if (!isRecord(tool)) return [`${itemPath} must be an object`];
    const itemErrors = [...unknownKeys(tool, QUALIFICATION_EFFECT_TOOL_KEYS, itemPath)];
    const canonicalId = ownField(tool, "canonicalId");
    if (typeof canonicalId !== "string" || !CANONICAL_TOOL_ID_PATTERN.test(canonicalId))
      itemErrors.push(`${itemPath}.canonicalId is invalid`);
    if (!positiveSafeInteger(ownField(tool, "contractVersion")))
      itemErrors.push(`${itemPath}.contractVersion must be a positive safe integer`);
    if (!positiveSafeInteger(ownField(tool, "invocationCount")))
      itemErrors.push(`${itemPath}.invocationCount must be a positive safe integer`);
    return itemErrors;
  });
  if (hasDuplicateObservedKeys(tools, ["canonicalId", "contractVersion"])) {
    errors.push(`${path}.effectStartedTools must group each tool reference once`);
  }
  if (sumObservedCounts(tools, "invocationCount") !== ownField(value, "effectStartedCount"))
    errors.push(`${path}.effectStartedTools must account for effectStartedCount`);
  return errors;
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

function qualificationAuthorityCountErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  if (invalidAuthorityAccounting(value)) {
    errors.push(`${path} must account for one or more settled tool invocations`);
  }
  if (requiresObservedApproval(value)) {
    errors.push(`${path} must retain at least one approval request`);
  }
  if (nonPositiveObservedCount(value, "effectStartedCount")) {
    errors.push(`${path} must retain at least one started effect`);
  }
  if (nonPositiveObservedCount(value, "completedToolCount")) {
    errors.push(`${path} must retain at least one completed tool invocation`);
  }
  if (startedEffectsExceedInvocations(value)) {
    errors.push(`${path}.effectStartedCount cannot exceed toolInvocationCount`);
  }
  if (approvedProposalsExceedRequests(value)) {
    errors.push(`${path}.approvedProposalActions must match observed approval requests`);
  }
  return errors;
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

function qualificationRubricReviewErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...unknownKeys(value, QUALIFICATION_RUBRIC_REVIEW_KEYS, path)];
  if (!isCodeTaskContentFreeNote(ownField(value, "reviewId"))) {
    errors.push(`${path}.reviewId must be a bounded content-free reference`);
  }
  for (const field of ["reviewDigest", "rubricDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
  }
  if (ownField(value, "verdict") !== "approved") errors.push(`${path}.verdict must be approved`);
  errors.push(...qualificationRubricReviewIdentityErrors(value, path));
  return errors;
}

function qualificationRubricReviewIdentityErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  if (!isCodeTaskScenarioId(ownField(value, "flowId"))) errors.push(`${path}.flowId is invalid`);
  if (!isCodeTaskContentFreeNote(ownField(value, "taskRunId"))) {
    errors.push(`${path}.taskRunId must be a bounded content-free reference`);
  }
  if (!GITHUB_REPOSITORY_PATTERN.test(String(ownField(value, "repository")))) {
    errors.push(`${path}.repository is invalid`);
  }
  for (const field of [
    "issueNumber",
    "pullRequestNumber",
    "criteriaTotal",
    "criteriaPassed",
  ] as const) {
    if (!isPositiveInteger(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
  }
  for (const field of ["pullRequestHeadSha", "sourceCommitSha"] as const) {
    if (!isCodeTaskGitCommitSha(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
  }
  if (ownField(value, "criteriaPassed") !== ownField(value, "criteriaTotal")) {
    errors.push(`${path} must report every independent criterion passed`);
  }
  return errors;
}

function qualificationStageReceiptErrors(
  value: unknown,
  path: string,
  expectedScenarioId: string,
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...unknownKeys(value, QUALIFICATION_STAGE_RECEIPT_KEYS, path)];
  if (
    !isCodeTaskScenarioId(ownField(value, "scenarioId")) ||
    ownField(value, "scenarioId") !== expectedScenarioId
  ) {
    errors.push(`${path}.scenarioId must be ${expectedScenarioId}`);
  }
  if (!isCodeTaskSha256Digest(ownField(value, "receiptDigest"))) {
    errors.push(`${path}.receiptDigest is invalid`);
  }
  return errors;
}

function qualificationFlowStageEvidenceErrors(
  value: unknown,
  flow: Record<string, unknown>,
  path: string,
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const mode = ownField(flow, "mode");
  const modeScenario = isOneOf(mode, QUALIFICATION_MODES)
    ? QUALIFICATION_MODE_SCENARIO_IDS[mode]
    : "invalid-mode";
  const errors = [
    ...unknownKeys(value, QUALIFICATION_FLOW_STAGE_EVIDENCE_KEYS, path),
    ...qualificationStageReceiptErrors(
      ownField(value, "issueToPr"),
      `${path}.issueToPr`,
      modeScenario,
    ),
    ...qualificationStageReceiptErrors(
      ownField(value, "description"),
      `${path}.description`,
      "description-auto-draft-and-apply",
    ),
    ...qualificationStageReceiptErrors(
      ownField(value, "markReady"),
      `${path}.markReady`,
      "mark-ready-intent",
    ),
    ...qualificationStageReceiptErrors(
      ownField(value, "governedMerge"),
      `${path}.governedMerge`,
      "human-merge-and-closure",
    ),
  ];
  errors.push(
    ...qualificationCiRepairStageErrors(value, path),
    ...qualificationStageDigestErrors(value, path),
  );
  return errors;
}

function qualificationCiRepairStageErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const ciRepair = ownField(value, "ciRepair");
  return ciRepair === null
    ? []
    : qualificationStageReceiptErrors(ciRepair, `${path}.ciRepair`, "ci-repair-loop");
}

function qualificationStageDigestErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const stages = QUALIFICATION_FLOW_STAGE_EVIDENCE_KEYS.map((key) => ownField(value, key)).filter(
    isRecord,
  );
  const digests = stages.map((stage) => ownField(stage, "receiptDigest"));
  return digests.every(isCodeTaskSha256Digest) && new Set(digests).size === digests.length
    ? []
    : [`${path} must contain distinct stage receipt digests`];
}

function qualificationFlowSpendErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...unknownKeys(value, QUALIFICATION_FLOW_SPEND_KEYS, path)];
  for (const field of QUALIFICATION_FLOW_SPEND_KEYS) {
    const amount = ownField(value, field);
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      errors.push(`${path}.${field} must be a non-negative safe integer`);
    }
  }
  const budget = ownField(value, "budgetNanoUsd");
  const cumulative = ownField(value, "cumulativeChargedNanoUsd");
  const remaining = ownField(value, "remainingNanoUsd");
  if (
    typeof budget === "number" &&
    typeof cumulative === "number" &&
    typeof remaining === "number" &&
    cumulative + remaining !== budget
  ) {
    errors.push(`${path} cumulative charge plus remaining amount must equal budget`);
  }
  return errors;
}

function qualificationFlowUrlErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  const repository = ownField(value, "repository");
  const issueNumber = ownField(value, "issueNumber");
  const pullRequestNumber = ownField(value, "pullRequestNumber");
  if (typeof repository !== "string" || !GITHUB_REPOSITORY_PATTERN.test(repository)) {
    errors.push(`${path}.repository must be a GitHub owner/name identity`);
  }
  if (
    typeof repository === "string" &&
    typeof issueNumber === "number" &&
    ownField(value, "issueReference") !==
      `https://github.com/${repository}/issues/${String(issueNumber)}`
  ) {
    errors.push(`${path}.issueReference does not match repository and issueNumber`);
  }
  if (
    typeof repository === "string" &&
    typeof pullRequestNumber === "number" &&
    ownField(value, "pullRequestReference") !==
      `https://github.com/${repository}/pull/${String(pullRequestNumber)}`
  ) {
    errors.push(`${path}.pullRequestReference does not match repository and pullRequestNumber`);
  }
  return errors;
}

function qualificationFlowReferenceErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors = [...qualificationFlowUrlErrors(value, path)];
  for (const field of [
    "repository",
    "issueReference",
    "taskRunId",
    "pullRequestReference",
  ] as const) {
    if (!isCodeTaskContentFreeNote(ownField(value, field))) {
      errors.push(`${path}.${field} must be a bounded content-free reference`);
    }
  }
  return errors;
}

function qualificationFlowIdentityErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors = [...qualificationFlowReferenceErrors(value, path)];
  if (!isCodeTaskScenarioId(ownField(value, "flowId"))) errors.push(`${path}.flowId is invalid`);
  if (!isPositiveInteger(ownField(value, "ordinal"))) errors.push(`${path}.ordinal is invalid`);
  if (!isPositiveInteger(ownField(value, "issueNumber"))) {
    errors.push(`${path}.issueNumber is invalid`);
  }
  if (!isPositiveInteger(ownField(value, "pullRequestNumber"))) {
    errors.push(`${path}.pullRequestNumber is invalid`);
  }
  if (!isOneOf(ownField(value, "mode"), QUALIFICATION_MODES)) {
    errors.push(`${path}.mode is invalid`);
  }
  return errors;
}

function qualificationFlowTimestampErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  for (const field of ["issueClosedAt", "pullRequestMergedAt", "observedAt"] as const) {
    if (!isCodeTaskIsoInstant(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
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
    errors.push(`${path} lifecycle timestamps are out of causal order`);
  }
  return errors;
}

function qualificationFlowCompletionErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  if (ownField(value, "issueState") !== "closed") errors.push(`${path}.issueState must be closed`);
  if (ownField(value, "pullRequestState") !== "merged") {
    errors.push(`${path}.pullRequestState must be merged`);
  }
  errors.push(...qualificationFlowTimestampErrors(value, path));
  for (const field of ["pullRequestHeadSha", "mergeCommitSha", "sourceCommitSha"] as const) {
    if (!isCodeTaskGitCommitSha(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
  }
  errors.push(
    ...qualificationRequiredChecksErrors(
      ownField(value, "requiredChecks"),
      `${path}.requiredChecks`,
    ),
    ...qualificationAuthorityObservationErrors(
      ownField(value, "authorityObservation"),
      `${path}.authorityObservation`,
    ),
    ...qualificationRubricReviewErrors(ownField(value, "rubricReview"), `${path}.rubricReview`),
    ...qualificationFlowStageEvidenceErrors(
      ownField(value, "stageEvidence"),
      value,
      `${path}.stageEvidence`,
    ),
    ...qualificationFlowSpendErrors(ownField(value, "spend"), `${path}.spend`),
  );
  const transitions = ownField(value, "transitions");
  if (
    !Array.isArray(transitions) ||
    transitions.length !== CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS.length ||
    transitions.some(
      (transition, index) => transition !== CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS[index],
    )
  ) {
    errors.push(`${path}.transitions must contain the complete ordered qualification journey`);
  }
  const checks = ownField(value, "requiredChecks");
  if (isRecord(checks) && ownField(checks, "headSha") !== ownField(value, "pullRequestHeadSha")) {
    errors.push(`${path}.requiredChecks.headSha must match pullRequestHeadSha`);
  }
  errors.push(...qualificationFlowEvidenceBindingErrors(value, path));
  return errors;
}

function qualificationFlowEvidenceBindingErrors(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const errors: string[] = [];
  const authority = ownField(value, "authorityObservation");
  if (
    isRecord(authority) &&
    (ownField(authority, "requestedMode") !== ownField(value, "mode") ||
      ownField(authority, "effectiveMode") !== ownField(value, "mode"))
  ) {
    errors.push(`${path}.authorityObservation must match the selected mode without escalation`);
  }
  const review = ownField(value, "rubricReview");
  if (!isRecord(review)) return errors;
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
    errors.push(`${path}.rubricReview must match the completed flow identity`);
  }
  return errors;
}

function qualificationFlowArtifactErrors(
  value: unknown,
  path: string,
  allowedKeys: readonly string[] = QUALIFICATION_FLOW_ARTIFACT_KEYS,
): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...unknownKeys(value, allowedKeys, path)];
  if (ownField(value, "evidenceKind") !== CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND) {
    errors.push(`${path}.evidenceKind is invalid`);
  }
  if (ownField(value, "schemaVersion") !== 1) errors.push(`${path}.schemaVersion must be 1`);
  errors.push(
    ...qualificationFlowIdentityErrors(value, path),
    ...qualificationFlowCompletionErrors(value, path),
  );
  return errors;
}

function qualificationFlowErrors(value: unknown, path: string): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = [...qualificationFlowArtifactErrors(value, path, QUALIFICATION_FLOW_KEYS)];
  if (!isOneOf(ownField(value, "platform"), CODE_TASK_EVIDENCE_PLATFORMS)) {
    errors.push(`${path}.platform is invalid`);
  }
  if (ownField(value, "provenance") !== "real-model") {
    errors.push(`${path}.provenance must be real-model`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "recordedAt"))) {
    errors.push(`${path}.recordedAt is invalid`);
  }
  for (const field of ["artifactDigest", "receiptDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, field))) errors.push(`${path}.${field} is invalid`);
  }
  return errors;
}

export function validateCodeTaskQualificationFlowArtifact(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskQualificationFlowArtifactV1> {
  const errors = qualificationFlowArtifactErrors(value, "flowArtifact");
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as CodeTaskQualificationFlowArtifactV1 };
}

function qualificationManifestHeaderErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (ownField(value, "kind") !== CODE_TASK_QUALIFICATION_MANIFEST_KIND) {
    errors.push(`kind must be ${CODE_TASK_QUALIFICATION_MANIFEST_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isPositiveInteger(ownField(value, "epicIssue"))) {
    errors.push("epicIssue must be a positive integer");
  }
  if (!isPositiveInteger(ownField(value, "childIssue"))) {
    errors.push("childIssue must be a positive integer");
  }
  if (!isCodeTaskGitCommitSha(ownField(value, "sourceCommitSha"))) {
    errors.push("sourceCommitSha is invalid");
  }
  if (!isCodeTaskGitTreeSha(ownField(value, "sourceTreeSha"))) {
    errors.push("sourceTreeSha is invalid");
  }
  return errors;
}

// Split out of qualificationManifestBodyErrors to keep both functions under the repository's
// per-function line ceiling: this half owns the scalar identity/reference fields, the other half
// owns the scenarios array and knownLimitations.
function qualificationManifestReferenceErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (!isCodeTaskContentFreeNote(ownField(value, "runtimeIdentity"))) {
    errors.push("runtimeIdentity must be a bounded content-free reference");
  }
  if (!isCodeTaskContentFreeNote(ownField(value, "modelIdentity"))) {
    errors.push("modelIdentity must be a bounded content-free reference");
  }
  if (!isCodeTaskContentFreeNote(ownField(value, "fixtureRevision"))) {
    errors.push("fixtureRevision must be a bounded content-free reference");
  }
  if (!isCodeTaskSha256Digest(ownField(value, "rubricDigest"))) {
    errors.push("rubricDigest is invalid");
  }
  errors.push(
    ...factErrors(ownField(value, "issueReference"), "issueReference", isCodeTaskContentFreeNote),
    ...factErrors(
      ownField(value, "pullRequestReference"),
      "pullRequestReference",
      isCodeTaskContentFreeNote,
    ),
    ...factErrors(ownField(value, "runReference"), "runReference", isCodeTaskContentFreeNote),
    ...factErrors(
      ownField(value, "readinessSnapshotDigest"),
      "readinessSnapshotDigest",
      isCodeTaskSha256Digest,
    ),
    ...factErrors(
      ownField(value, "journeyOutcomeDigest"),
      "journeyOutcomeDigest",
      isCodeTaskSha256Digest,
    ),
    ...factErrors(ownField(value, "auditReference"), "auditReference", isCodeTaskContentFreeNote),
    ...factErrors(ownField(value, "auditDigest"), "auditDigest", isCodeTaskSha256Digest),
    ...factErrors(
      ownField(value, "humanMergeAttestationDigest"),
      "humanMergeAttestationDigest",
      isCodeTaskSha256Digest,
    ),
  );
  return errors;
}

function qualificationManifestRequiredToolsErrors(
  value: Record<string, unknown>,
): readonly string[] {
  const requiredTools = ownField(value, "requiredTools");
  if (!Array.isArray(requiredTools) || !requiredTools.every((tool) => isCodeTaskToolName(tool))) {
    return ["requiredTools must be an array of catalog tool names"];
  }
  if (
    requiredTools.length !== CODE_TASK_QUALIFICATION_REQUIRED_TOOLS.length ||
    CODE_TASK_QUALIFICATION_REQUIRED_TOOLS.some(
      (expected, index) => requiredTools[index] !== expected,
    )
  ) {
    return ["requiredTools must exactly match the controlled-journey rubric inventory"];
  }
  return [];
}

// #3390 audit F15: the bounded evaluation budget the run was launched with, plus what the gateway
// actually reported spending. `spendBudgetUsd` is always a known positive amount by construction
// (the run cannot start without one); `observedSpendUsd` is a tagged fact because a gateway that
// does not report spend must never be recorded as having spent zero.
function qualificationManifestSpendErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  const spendBudgetUsd = ownField(value, "spendBudgetUsd");
  if (!isNonNegativeAmountUsd(spendBudgetUsd) || spendBudgetUsd <= 0) {
    errors.push("spendBudgetUsd must be a positive, bounded USD amount");
  }
  errors.push(
    ...factErrors(ownField(value, "observedSpendUsd"), "observedSpendUsd", isNonNegativeAmountUsd),
  );
  return errors;
}

function qualificationManifestBodyErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [
    ...qualificationManifestReferenceErrors(value),
    ...qualificationManifestRequiredToolsErrors(value),
    ...qualificationManifestSpendErrors(value),
  ];
  const scenarios = ownField(value, "scenarios");
  if (Array.isArray(scenarios)) {
    scenarios.forEach((scenario, index) => {
      errors.push(...qualificationScenarioErrors(scenario, `scenarios[${String(index)}]`));
    });
  } else {
    errors.push("scenarios must be an array");
  }
  const flows = ownField(value, "flows");
  if (Array.isArray(flows)) {
    flows.forEach((flow, index) => {
      errors.push(...qualificationFlowErrors(flow, `flows[${String(index)}]`));
    });
  } else {
    errors.push("flows must be an array");
  }
  const knownLimitations = ownField(value, "knownLimitations");
  if (
    !Array.isArray(knownLimitations) ||
    !knownLimitations.every((note) => isCodeTaskContentFreeNote(note))
  ) {
    errors.push("knownLimitations must be an array of bounded content-free notes");
  }
  return errors;
}

export function validateCodeTaskQualificationManifest(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskQualificationManifestV1> {
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"] };
  const errors = [
    ...unknownKeys(value, QUALIFICATION_MANIFEST_KEYS, "manifest"),
    ...qualificationManifestHeaderErrors(value),
    ...qualificationManifestBodyErrors(value),
  ];
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodeTaskQualificationManifestV1 };
}

// Split out of codeTaskQualificationManifestFailures to keep that function's cyclomatic
// complexity under the repository ceiling: these are the three per-scenario rules, evaluated once
// per entry in the loop below.
function scenarioQualificationFailures(
  scenario: CodeTaskQualificationScenarioV1,
  registeredScenarioIds: ReadonlySet<string>,
  registeredProductionFunctionalScenarioIds: ReadonlySet<string>,
): readonly string[] {
  const failures: string[] = [];
  if (!registeredScenarioIds.has(scenario.scenarioId)) {
    failures.push(`unregistered scenario: ${scenario.scenarioId}`);
  }
  if (scenario.outcome === "blocked" && scenario.blockedReason.outcome !== "known") {
    failures.push(`blocked scenario missing reason: ${scenario.scenarioId}`);
  }
  if (scenario.outcome === "passed" && scenario.provenance === "scripted") {
    failures.push(
      `scripted-model provenance cannot establish qualification: ${scenario.scenarioId}`,
    );
  }
  if (
    scenario.outcome === "passed" &&
    scenario.provenance === "production-functional" &&
    (scenario.evidenceClass !== "production-functional" ||
      !registeredProductionFunctionalScenarioIds.has(scenario.scenarioId))
  ) {
    failures.push(
      `production-functional provenance is not trusted for scenario: ${scenario.scenarioId}`,
    );
  }
  return failures;
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
function manifestCrossFieldFailures(manifest: CodeTaskQualificationManifestV1): readonly string[] {
  const failures: string[] = [];
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
