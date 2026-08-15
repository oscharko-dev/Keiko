// Cross-child governance contracts for Epic #2384 Code-task children (Issue #2386). These are
// acceptance boundaries, not implementation suggestions: every value is a readonly, JSON-
// serializable discriminated union with literal `schemaVersion: 1`; identity values use validated
// branded opaque strings; optional facts use an explicit tagged outcome, never `undefined`. The
// payloads are content-free — ids, digests, decisions, and revisions only, never prompts, diffs,
// command bodies, file bodies, question/answer text, endpoints, or credentials.
//
// This module defines: the task-grant scope (#2386), `GovernedActionV1` (produced for #2387), and
// `CodeTaskExecutionV1` (the named projection consumed from #2385). `RunControlSnapshotV1` and
// `RuntimeGovernancePortV1` live in `./code-task-run-control.ts` and reuse the branded ids here.
import type { CodeTaskFact } from "./code-task-acceptance.js";
import {
  hasInheritedEnumerableProperty,
  isCodeTaskIsoInstant,
  isCodeTaskSha256Digest,
  ownField,
} from "./code-task-acceptance.js";
import type { CodingWorkbenchMode, CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { CODING_WORKBENCH_MODES } from "./coding-workbench.js";
import type { CodingWorkbenchRuntimeStateName } from "./coding-workbench-runtime.js";
import { CODING_WORKBENCH_RUNTIME_STATE_NAMES } from "./coding-workbench-runtime.js";

export const CODE_TASK_GOVERNANCE_SCHEMA_VERSION = 1;

declare const codeTaskGovernanceBrand: unique symbol;

/** Type-level brand; branded values stay JSON-serializable primitive strings at runtime. */
export type CodeTaskGovernanceBranded<Name extends string> = string & {
  readonly [codeTaskGovernanceBrand]: Name;
};

export type CodeTaskTaskId = CodeTaskGovernanceBranded<"CodeTaskTaskId">;
export type CodeTaskRunId = CodeTaskGovernanceBranded<"CodeTaskRunId">;
export type CodeTaskWorkspaceId = CodeTaskGovernanceBranded<"CodeTaskWorkspaceId">;
export type CodeTaskGrantId = CodeTaskGovernanceBranded<"CodeTaskGrantId">;
export type CodeTaskQuestionId = CodeTaskGovernanceBranded<"CodeTaskQuestionId">;
export type CodeTaskIdempotencyKey = CodeTaskGovernanceBranded<"CodeTaskIdempotencyKey">;
export type CodeTaskPolicyVersion = CodeTaskGovernanceBranded<"CodeTaskPolicyVersion">;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const QUESTION_ID_PATTERN = /^que_[A-Za-z0-9_-]{1,251}$/u;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export function isCodeTaskTaskId(value: unknown): value is CodeTaskTaskId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskRunId(value: unknown): value is CodeTaskRunId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskWorkspaceId(value: unknown): value is CodeTaskWorkspaceId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskGrantId(value: unknown): value is CodeTaskGrantId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskQuestionId(value: unknown): value is CodeTaskQuestionId {
  return typeof value === "string" && QUESTION_ID_PATTERN.test(value);
}
export function isCodeTaskIdempotencyKey(value: unknown): value is CodeTaskIdempotencyKey {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskPolicyVersion(value: unknown): value is CodeTaskPolicyVersion {
  return typeof value === "string" && POLICY_VERSION_PATTERN.test(value);
}

// KfQ Critical on code-task-acceptance.ts's identical unknownKeys (this file mirrors it): a value
// shaped via Object.create(secretHolder) can carry every required field as an OWN property (so it
// looks complete) plus one extra field reachable ONLY through the prototype -- verified empirically
// that such a value's own-property count and names match an honest input exactly, so no
// own-property-only scan (Object.keys, Object.getOwnPropertyNames, or an exact-own-count check)
// ever sees the extra field, while ordinary property access on it still resolves through the
// prototype chain. Rejecting any non-default prototype closes this at the single choke point every
// validator in this file already passes through.
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

// Object.getOwnPropertyNames (not Object.keys) plus an own-symbol check, matching
// debug/debug-lifecycle.ts's idiom: Object.keys alone misses a non-enumerable own property. Every
// caller here already passes through the hardened isRecord above, which is what actually closes
// the prototype case (see its own comment).
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

// A content-free failure reason: a bounded lower-kebab reason code that cannot smuggle secrets or
// free text across the acceptance boundary (mirrors the code-task-acceptance content-free rule).
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

// Exported: this is the ONE definition of the content-free reason-code rule. It was previously
// re-declared verbatim in code-task-auxiliary.ts and enforced as a length-only check in
// code-task-run-control.ts, so the "cannot smuggle secrets or free text" guarantee held in one of
// the three places that claimed it — "Denied: /Users/alice/secret" is 64 characters or fewer.
export function isContentFreeReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

// ─── Task-grant scope (#2386) ──────────────────────────────────────────────────────
// "Run once" is single-use; "Allow for this task" survives consume but revalidates every binding
// dimension on each reuse. An absent scope defaults to the safest posture ("once"); a present but
// unrecognized scope fails closed to a validation error (deny), never a silent downgrade.
export const CODE_TASK_GRANT_SCOPES = Object.freeze(["once", "task"] as const);
export type CodeTaskGrantScope = (typeof CODE_TASK_GRANT_SCOPES)[number];

export function isCodeTaskGrantScope(value: unknown): value is CodeTaskGrantScope {
  return isOneOf(value, CODE_TASK_GRANT_SCOPES);
}

/**
 * Resolve a possibly-absent grant scope. `undefined` (absent) resolves to the safe default
 * "once"; any present value that is not a recognized scope fails closed with an error rather than
 * being downgraded, so a hostile or malformed scope can never widen or silently narrow authority.
 */
export function resolveCodeTaskGrantScope(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskGrantScope> {
  if (value === undefined) return { ok: true, value: "once" };
  if (isCodeTaskGrantScope(value)) return { ok: true, value };
  return { ok: false, errors: ['grantScope must be omitted, "once", or "task"'] };
}

// ─── GovernedActionV1 (produced for #2387) ─────────────────────────────────────────
// The central decision function is total over these normalized action kinds. Unknown or malformed
// action input fails denied (never allowed). External-file apply-back, dependency operations,
// delivery, and authority widening are never covered by an auto-approved task grant.
export const GOVERNED_ACTION_KIND = "governed-action";
export const GOVERNED_ACTION_ACTION_KINDS = Object.freeze([
  "workspace-read",
  "workspace-edit",
  "vetted-command",
  "dependency-operation",
  "read-only-research",
  "external-file-apply-back",
  "delivery",
  "authority-widening",
] as const);
export type GovernedActionActionKind = (typeof GOVERNED_ACTION_ACTION_KINDS)[number];

export const GOVERNED_ACTION_DECISIONS = Object.freeze([
  "allowed",
  "approval-required",
  "denied",
  "stale",
  "expired",
  "unsupported",
  "cancelled",
  "failed",
] as const);
export type GovernedActionDecision = (typeof GOVERNED_ACTION_DECISIONS)[number];

/** Action kinds that can never be covered by an auto-approved task grant (#2384 exclusion set). */
export const GOVERNED_ACTION_UNGRANTABLE_KINDS = Object.freeze([
  "dependency-operation",
  "external-file-apply-back",
  "delivery",
  "authority-widening",
] as const satisfies readonly GovernedActionActionKind[]);

export function isGovernedActionGrantable(kind: GovernedActionActionKind): boolean {
  return !(GOVERNED_ACTION_UNGRANTABLE_KINDS as readonly GovernedActionActionKind[]).includes(kind);
}

export interface GovernedActionGrantRef {
  readonly grantId: CodeTaskGrantId;
  readonly grantScope: CodeTaskGrantScope;
}

export interface GovernedActionQuestionRef {
  readonly questionId: CodeTaskQuestionId;
  readonly expectedRevision: number;
}

/** Explicit "no reference" outcome; the only tagged fact a non-carrying decision may hold. */
export interface GovernedActionAbsent {
  readonly outcome: "absent";
}

export interface GovernedActionEnvelope {
  readonly kind: typeof GOVERNED_ACTION_KIND;
  readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
  readonly taskId: CodeTaskTaskId;
  readonly runId: CodeTaskRunId;
  readonly workspaceId: CodeTaskWorkspaceId;
  readonly stateRevision: number;
  readonly actionKind: GovernedActionActionKind;
}

/**
 * Discriminated on `decision`. Only "allowed" may carry a task grant; only "approval-required" may
 * carry a pending question; every other decision explicitly carries no reference on both axes.
 */
export type GovernedActionV1 =
  | (GovernedActionEnvelope & {
      readonly decision: "allowed";
      readonly grant: CodeTaskFact<GovernedActionGrantRef>;
      readonly question: GovernedActionAbsent;
    })
  | (GovernedActionEnvelope & {
      readonly decision: "approval-required";
      readonly grant: GovernedActionAbsent;
      readonly question: CodeTaskFact<GovernedActionQuestionRef>;
    })
  | (GovernedActionEnvelope & {
      readonly decision: Exclude<GovernedActionDecision, "allowed" | "approval-required">;
      readonly grant: GovernedActionAbsent;
      readonly question: GovernedActionAbsent;
    });

function envelopeErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (ownField(value, "kind") !== GOVERNED_ACTION_KIND) {
    errors.push(`kind must be ${GOVERNED_ACTION_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(ownField(value, "taskId"))) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId"))) errors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(ownField(value, "workspaceId"))) errors.push("workspaceId is invalid");
  if (!isNonNegativeInteger(ownField(value, "stateRevision"))) {
    errors.push("stateRevision must be a non-negative integer");
  }
  if (!isOneOf(ownField(value, "actionKind"), GOVERNED_ACTION_ACTION_KINDS)) {
    errors.push("actionKind is invalid");
  }
  return errors;
}

// KEIKO-0302 follow-on: this only excluded a literal "value" key, so { outcome: "absent",
// promptText: "leak me" } passed as absent on the denied/non-carrying decision path (and on the
// "allowed" question / "approval-required" grant paths, both of which route through
// absentErrors). GovernedActionAbsent's only field is "outcome" (see its definition above), so
// requiring exactly one key rejects every extra key, not just "value".
// Round 3 (#2899), proactive (not named by Codex/KfQ, but the same class of gap they found
// elsewhere in this file): the own-property-COUNT check alone does not verify WHICH key is
// present. Object.prototype polluted with outcome: "absent" lets `{ foo: "bar" }` -- one own key,
// but not "outcome" -- pass every condition here: isRecord (default prototype, untouched by this
// polluted-in-place mutation), value.outcome === "absent" (resolved via inheritance), and an own
// count of exactly 1 (satisfied by the unrelated "foo").
// Codex P1 3789773829: hasInheritedEnumerableProperty alone is not enough either -- it only sees
// an ENUMERABLE inherited property, and Object.defineProperty(Object.prototype, "outcome", {
// value: "absent", enumerable: false }) is invisible to it while value.outcome still resolves to
// "absent". Reading through ownField (imported from code-task-acceptance.ts) instead of plain
// property access is what actually closes this: ownField answers ownership, never resolution, so
// no property-descriptor shape (enumerable, non-enumerable, or whatever comes next) matters here.
// hasInheritedEnumerableProperty is kept as an extra, cheaper rejection for the common case, not as
// the check this predicate depends on for correctness.
function isAbsent(value: unknown): value is GovernedActionAbsent {
  // getOwnPropertyNames + no-symbols, matching unknownKeys above: Object.keys alone misses a
  // non-enumerable own property. isRecord already rejects a non-default prototype.
  return (
    isRecord(value) &&
    !hasInheritedEnumerableProperty(value) &&
    ownField(value, "outcome") === "absent" &&
    Object.getOwnPropertyNames(value).length === 1 &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

// KEIKO-0302 follow-on: this checked the INNER grant.value object's own keys but never the outer
// fact wrapper's, so a well-formed known fact padded with an extra field (e.g. free text riding
// alongside a valid grant) validated and was returned verbatim. The "grant must not carry a
// value" message for the absent+value case is preserved exactly (pinned test); any OTHER extra
// key on either branch is now also rejected via the shared unknownKeys helper.
// Round 3 (#2899): the absent branch's "value" in value check and the known branch's
// wrapperExtraKeys check were both early-returns -- an object with two independent problems (an
// inherited/extra field AND an invalid inner grant, or a wrapper extra key AND an invalid inner
// grant) only ever reported one. Replaced the absent branch's field-specific check with the shared
// hasInheritedEnumerableProperty guard (imported from code-task-acceptance.ts: see its definition
// there for why this is a strict superset of "value" in value, and why reuse over a fourth copy),
// called upfront so it also covers the known branch's wrapper. Both branches now collect.
function grantRefFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["grant must be a tagged fact object"];
  if (hasInheritedEnumerableProperty(value)) {
    return ["grant must not resolve any field through its prototype chain"];
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "absent") {
    const errors = unknownKeys(value, ["outcome"], "grant");
    if (Object.hasOwn(value, "value")) errors.push("grant must not carry a value");
    return errors;
  }
  if (outcome !== "known") return ["grant.outcome must be known or absent"];
  const errors = unknownKeys(value, ["outcome", "value"], "grant");
  const grant = ownField(value, "value");
  if (!isRecord(grant)) {
    errors.push("grant.value must be an object");
    return errors;
  }
  errors.push(...unknownKeys(grant, ["grantId", "grantScope"], "grant.value"));
  if (!isCodeTaskGrantId(ownField(grant, "grantId"))) errors.push("grant.value.grantId is invalid");
  if (!isCodeTaskGrantScope(ownField(grant, "grantScope"))) {
    errors.push("grant.value.grantScope is invalid");
  }
  return errors;
}

// Same fix as grantRefFactErrors above, for the question fact.
function questionRefFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["question must be a tagged fact object"];
  if (hasInheritedEnumerableProperty(value)) {
    return ["question must not resolve any field through its prototype chain"];
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "absent") {
    const errors = unknownKeys(value, ["outcome"], "question");
    if (Object.hasOwn(value, "value")) errors.push("question must not carry a value");
    return errors;
  }
  if (outcome !== "known") return ["question.outcome must be known or absent"];
  const errors = unknownKeys(value, ["outcome", "value"], "question");
  const question = ownField(value, "value");
  if (!isRecord(question)) {
    errors.push("question.value must be an object");
    return errors;
  }
  errors.push(...unknownKeys(question, ["questionId", "expectedRevision"], "question.value"));
  if (!isCodeTaskQuestionId(ownField(question, "questionId"))) {
    errors.push("question.value.questionId is invalid");
  }
  if (!isNonNegativeInteger(ownField(question, "expectedRevision"))) {
    errors.push("question.value.expectedRevision must be a non-negative integer");
  }
  return errors;
}

// A "known" grant on an ungrantable action kind (delivery, authority-widening, dependency-operation,
// external-file-apply-back) is rejected: those actions can never be covered by a stored grant and
// require separate explicit approval every time (the structural exclusion invariant).
function allowedGrantExclusionErrors(value: Record<string, unknown>): string[] {
  const grant = ownField(value, "grant");
  if (!isRecord(grant) || ownField(grant, "outcome") !== "known") return [];
  const actionKind = ownField(value, "actionKind");
  if (isOneOf(actionKind, GOVERNED_ACTION_ACTION_KINDS) && isGovernedActionGrantable(actionKind)) {
    return [];
  }
  return ["grant is not permitted on a structurally ungrantable action kind"];
}

function governedActionRefErrors(value: Record<string, unknown>): string[] {
  const decision = ownField(value, "decision");
  if (decision === "allowed") {
    return [
      ...grantRefFactErrors(ownField(value, "grant")),
      ...allowedGrantExclusionErrors(value),
      ...absentErrors(ownField(value, "question"), "question"),
    ];
  }
  if (decision === "approval-required") {
    return [
      ...absentErrors(ownField(value, "grant"), "grant"),
      ...questionRefFactErrors(ownField(value, "question")),
    ];
  }
  return [
    ...absentErrors(ownField(value, "grant"), "grant"),
    ...absentErrors(ownField(value, "question"), "question"),
  ];
}

function absentErrors(value: unknown, path: string): string[] {
  return isAbsent(value) ? [] : [`${path} must be an explicit { outcome: "absent" } fact`];
}

const GOVERNED_ACTION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "taskId",
  "runId",
  "workspaceId",
  "stateRevision",
  "actionKind",
  "decision",
  "grant",
  "question",
]);

export function validateGovernedActionV1(
  value: unknown,
): CodingWorkbenchValidationResult<GovernedActionV1> {
  if (!isRecord(value)) return { ok: false, errors: ["governed action must be an object"] };
  // getOwnPropertyNames + no-symbols, matching unknownKeys above: Object.keys alone misses a
  // non-enumerable own property. isRecord already rejects a non-default prototype.
  const errors = Object.getOwnPropertyNames(value)
    .filter((key) => !GOVERNED_ACTION_KEYS.has(key))
    .map((key) => `governedAction.${key} is not allowed`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    errors.push("governedAction must not carry symbol-keyed properties");
  }
  errors.push(...envelopeErrors(value));
  if (!isOneOf(ownField(value, "decision"), GOVERNED_ACTION_DECISIONS)) {
    errors.push("decision is invalid");
  } else {
    errors.push(...governedActionRefErrors(value));
  }
  return errors.length === 0
    ? { ok: true, value: value as unknown as GovernedActionV1 }
    : { ok: false, errors };
}

// ─── CodeTaskExecutionV1 (consumed from #2385) ─────────────────────────────────────
// A named, content-free projection over the server-owned runtime snapshot plus its authority
// envelope. It carries digests and lifecycle facts, never the objective text, prompt, or diff.
export const CODE_TASK_EXECUTION_KIND = "code-task-execution";

export interface CodeTaskExecutionV1 {
  readonly kind: typeof CODE_TASK_EXECUTION_KIND;
  readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
  readonly taskId: CodeTaskTaskId;
  readonly runId: CodeTaskRunId;
  readonly workspaceId: CodeTaskWorkspaceId;
  readonly requestedMode: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly stateRevision: number;
  readonly runEpoch: number;
  readonly objectiveDigest: string;
  readonly authorityEnvelopeDigest: string;
  readonly updatedAt: string;
  /** Present only for a failed/recovery lifecycle; otherwise an explicit absent fact. */
  readonly failure: CodeTaskFact<string>;
}

const CODE_TASK_EXECUTION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "taskId",
  "runId",
  "workspaceId",
  "requestedMode",
  "effectiveMode",
  "deploymentCeiling",
  "state",
  "stateRevision",
  "runEpoch",
  "objectiveDigest",
  "authorityEnvelopeDigest",
  "updatedAt",
  "failure",
]);

function executionHeaderErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (ownField(value, "kind") !== CODE_TASK_EXECUTION_KIND) {
    errors.push(`kind must be ${CODE_TASK_EXECUTION_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(ownField(value, "taskId"))) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId"))) errors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(ownField(value, "workspaceId"))) errors.push("workspaceId is invalid");
  return errors;
}

function executionModeErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["requestedMode", "effectiveMode", "deploymentCeiling"] as const) {
    if (!isOneOf(ownField(value, key), CODING_WORKBENCH_MODES)) errors.push(`${key} is invalid`);
  }
  if (!isOneOf(ownField(value, "state"), CODING_WORKBENCH_RUNTIME_STATE_NAMES)) {
    errors.push("state is invalid");
  }
  return errors;
}

function executionFactErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["stateRevision", "runEpoch"] as const) {
    if (!isNonNegativeInteger(ownField(value, key))) {
      errors.push(`${key} must be a non-negative integer`);
    }
  }
  for (const key of ["objectiveDigest", "authorityEnvelopeDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, key)))
      errors.push(`${key} must be a sha256 digest`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "updatedAt"))) {
    errors.push("updatedAt must be an ISO-8601 UTC instant");
  }
  errors.push(...executionFailureFactErrors(ownField(value, "failure")));
  return errors;
}

// KEIKO-0302 follow-on: same gap as grantRefFactErrors/questionRefFactErrors above — the "known"
// branch validated value.value but never rejected an extra key riding alongside it, and the other
// three outcomes only checked for a stray "value" key, not any other extra key. The
// `failure must not carry a value for outcome ${outcome}` message is preserved exactly for that
// one pinned case; every other extra key is now also rejected via unknownKeys.
// Round 3 (#2899): same early-return-vs-collect and per-key-vs-general-guard gaps as
// grantRefFactErrors/questionRefFactErrors above, fixed the same way.
function executionFailureFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["failure must be a tagged fact object"];
  if (hasInheritedEnumerableProperty(value)) {
    return ["failure must not resolve any field through its prototype chain"];
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") {
    const errors = unknownKeys(value, ["outcome", "value"], "failure");
    if (!isContentFreeReasonCode(ownField(value, "value"))) {
      errors.push("failure.value must be a bounded content-free reason code");
    }
    return errors;
  }
  if (outcome === "absent" || outcome === "unavailable" || outcome === "unknown") {
    const errors = unknownKeys(value, ["outcome"], "failure");
    if (Object.hasOwn(value, "value")) {
      errors.push(`failure must not carry a value for outcome ${outcome}`);
    }
    return errors;
  }
  return ["failure.outcome must be known, absent, unavailable, or unknown"];
}

export function validateCodeTaskExecutionV1(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskExecutionV1> {
  if (!isRecord(value)) return { ok: false, errors: ["code-task execution must be an object"] };
  // getOwnPropertyNames + no-symbols, matching unknownKeys above: Object.keys alone misses a
  // non-enumerable own property. isRecord already rejects a non-default prototype.
  const errors = Object.getOwnPropertyNames(value)
    .filter((key) => !CODE_TASK_EXECUTION_KEYS.has(key))
    .map((key) => `codeTaskExecution.${key} is not allowed`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    errors.push("codeTaskExecution must not carry symbol-keyed properties");
  }
  errors.push(
    ...executionHeaderErrors(value),
    ...executionModeErrors(value),
    ...executionFactErrors(value),
  );
  return errors.length === 0
    ? { ok: true, value: value as unknown as CodeTaskExecutionV1 }
    : { ok: false, errors };
}
