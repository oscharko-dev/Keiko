import {
  isCodeTaskRecord as isRecord,
  validateCodeTaskOwnKeys,
} from "./code-task-record-validation.js";
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

import type {
  CodeTaskGrantId,
  CodeTaskPolicyVersion,
  CodeTaskQuestionId,
  CodeTaskRunId,
  CodeTaskTaskId,
  CodeTaskWorkspaceId,
} from "./code-task-target-validation.js";
import {
  validateCodeTaskParentTarget,
  validateCodeTaskHeaderTags,
  isCodeTaskGrantId,
  isCodeTaskRunId,
  isCodeTaskTaskId,
  isCodeTaskWorkspaceId,
} from "./code-task-target-validation.js";
export type {
  CodeTaskGovernanceBranded,
  CodeTaskGrantId,
  CodeTaskIdempotencyKey,
  CodeTaskPolicyVersion,
  CodeTaskQuestionId,
  CodeTaskRunId,
  CodeTaskTaskId,
  CodeTaskWorkspaceId,
} from "./code-task-target-validation.js";
export {
  isCodeTaskGrantId,
  isCodeTaskIdempotencyKey,
  isCodeTaskRunId,
  isCodeTaskTaskId,
  isCodeTaskWorkspaceId,
} from "./code-task-target-validation.js";

export const CODE_TASK_GOVERNANCE_SCHEMA_VERSION = 1;

const QUESTION_ID_PATTERN = /^que_[A-Za-z0-9_-]{1,251}$/u;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export function isCodeTaskQuestionId(value: unknown): value is CodeTaskQuestionId {
  return typeof value === "string" && QUESTION_ID_PATTERN.test(value);
}
export function isCodeTaskPolicyVersion(value: unknown): value is CodeTaskPolicyVersion {
  return typeof value === "string" && POLICY_VERSION_PATTERN.test(value);
}

// KfQ Critical: the shared strict Code-task record admission rejects a value
// shaped via Object.create(secretHolder) can carry every required field as an OWN property (so it
// looks complete) plus one extra field reachable ONLY through the prototype -- verified empirically
// that such a value's own-property count and names match an honest input exactly, so no
// own-property-only scan (Object.keys, Object.getOwnPropertyNames, or an exact-own-count check)
// ever sees the extra field, while ordinary property access on it still resolves through the
// prototype chain. Rejecting any non-default prototype closes this at the single choke point every
// validator in this file already passes through.
function addValidationError(errors: string[], message: string): false {
  errors.push(message);
  return false;
}

function appendValidationErrors(errors: string[], messages: readonly string[]): boolean {
  errors.push(...messages);
  return messages.length === 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
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
  const ungrantable: readonly GovernedActionActionKind[] = GOVERNED_ACTION_UNGRANTABLE_KINDS;
  return !ungrantable.includes(kind);
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

// KEIKO-0755: `grantRefFactErrors` and `questionRefFactErrors` reject every outcome except
// "known" and "absent" — but the field types below declared the full four-outcome CodeTaskFact
// union, so at compile time a producer could construct a `{ outcome: "unknown" }` grant/question
// that would still typecheck cleanly before being rejected at runtime. Narrow the type so an
// unsupported outcome is a compile error at the producer.
export type CodeTaskKnownOrAbsentFact<Value> = Extract<
  CodeTaskFact<Value>,
  { readonly outcome: "known" } | { readonly outcome: "absent" }
>;

/**
 * Discriminated on `decision`. Only "allowed" may carry a task grant; only "approval-required" may
 * carry a pending question; every other decision explicitly carries no reference on both axes.
 */
export type GovernedActionV1 =
  | (GovernedActionEnvelope & {
      readonly decision: "allowed";
      readonly grant: CodeTaskKnownOrAbsentFact<GovernedActionGrantRef>;
      readonly question: GovernedActionAbsent;
    })
  | (GovernedActionEnvelope & {
      readonly decision: "approval-required";
      readonly grant: GovernedActionAbsent;
      readonly question: CodeTaskKnownOrAbsentFact<GovernedActionQuestionRef>;
    })
  | (GovernedActionEnvelope & {
      readonly decision: Exclude<GovernedActionDecision, "allowed" | "approval-required">;
      readonly grant: GovernedActionAbsent;
      readonly question: GovernedActionAbsent;
    });

function envelopeFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  if (ownField(value, "kind") !== GOVERNED_ACTION_KIND) {
    valid = addValidationError(errors, `kind must be ${GOVERNED_ACTION_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  valid = validateCodeTaskParentTarget(errors, value) && valid;
  if (!isOneOf(ownField(value, "actionKind"), GOVERNED_ACTION_ACTION_KINDS)) {
    valid = addValidationError(errors, "actionKind is invalid");
  }
  return valid;
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
  // getOwnPropertyNames + no-symbols, matching shared unknownKeys: Object.keys alone misses a
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
function grantReferenceValueFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  const grant = ownField(value, "value");
  if (!isRecord(grant)) {
    valid = addValidationError(errors, "grant.value must be an object");
    return valid;
  }
  valid = validateCodeTaskOwnKeys(errors, grant, ["grantId", "grantScope"], "grant.value") && valid;
  if (!isCodeTaskGrantId(ownField(grant, "grantId")))
    valid = addValidationError(errors, "grant.value.grantId is invalid");
  if (!isCodeTaskGrantScope(ownField(grant, "grantScope"))) {
    valid = addValidationError(errors, "grant.value.grantScope is invalid");
  }
  return valid;
}

function grantRefFactFieldsAreValid(errors: string[], value: unknown): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "grant must be a tagged fact object");
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      "grant must not resolve any field through its prototype chain",
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "absent") {
    valid = validateCodeTaskOwnKeys(errors, value, ["outcome"], "grant") && valid;
    if (Object.hasOwn(value, "value"))
      valid = addValidationError(errors, "grant must not carry a value");
    return valid;
  }
  if (outcome !== "known")
    return addValidationError(errors, "grant.outcome must be known or absent");
  valid = validateCodeTaskOwnKeys(errors, value, ["outcome", "value"], "grant") && valid;
  valid = grantReferenceValueFieldsAreValid(errors, value) && valid;
  return valid;
}

// Same fix as grantRefFactErrors above, for the question fact.
function questionReferenceValueFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  const question = ownField(value, "value");
  if (!isRecord(question)) {
    valid = addValidationError(errors, "question.value must be an object");
    return valid;
  }
  valid =
    validateCodeTaskOwnKeys(
      errors,
      question,
      ["questionId", "expectedRevision"],
      "question.value",
    ) && valid;
  if (!isCodeTaskQuestionId(ownField(question, "questionId"))) {
    valid = addValidationError(errors, "question.value.questionId is invalid");
  }
  if (!isNonNegativeInteger(ownField(question, "expectedRevision"))) {
    valid = addValidationError(
      errors,
      "question.value.expectedRevision must be a non-negative integer",
    );
  }
  return valid;
}

function questionRefFactFieldsAreValid(errors: string[], value: unknown): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "question must be a tagged fact object");
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      "question must not resolve any field through its prototype chain",
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "absent") {
    valid = validateCodeTaskOwnKeys(errors, value, ["outcome"], "question") && valid;
    if (Object.hasOwn(value, "value"))
      valid = addValidationError(errors, "question must not carry a value");
    return valid;
  }
  if (outcome !== "known")
    return addValidationError(errors, "question.outcome must be known or absent");
  valid = validateCodeTaskOwnKeys(errors, value, ["outcome", "value"], "question") && valid;
  valid = questionReferenceValueFieldsAreValid(errors, value) && valid;
  return valid;
}

// A "known" grant on an ungrantable action kind (delivery, authority-widening, dependency-operation,
// external-file-apply-back) is rejected: those actions can never be covered by a stored grant and
// require separate explicit approval every time (the structural exclusion invariant).
// KfQ 3789983129: ownField(grant, "outcome") !== "known" used to be the WHOLE test for "nothing to
// exclude-check here, skip" -- but that is exactly the mirror risk of ownField itself: undefined
// (grant.outcome unreadable because it is only inherited) satisfies `!== "known"` identically to a
// genuinely non-known grant, so this function silently returned [] for BOTH. ownField is correct
// for a REJECTING read (undefined never equals a required literal, so it falls through to an
// error); it is wrong for a PRESENCE-gated read whose false branch is "skip, nothing to check" --
// there, invisible must not collapse onto "legitimately not applicable". Verified by construction
// before this fix: grantRefFactErrors (run separately on the same grant) already rejects this exact
// shape via its own "grant.outcome must be known or absent" message, so validateGovernedActionV1's
// overall ok:false was never actually wrong -- but this function's OWN return value was, and a
// future caller of this exclusion rule in isolation (or a change to grantRefFactErrors) must not be
// able to inherit that latent gap. Object.hasOwn(grant, "outcome") makes "outcome is not this
// grant's own property" its own explicit, rejecting branch instead of folding it into "not known".
function allowedGrantExclusionFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  const grant = ownField(value, "grant");
  if (!isRecord(grant)) return true;
  if (!Object.hasOwn(grant, "outcome")) {
    return addValidationError(
      errors,
      "grant.outcome must be its own property to evaluate the exclusion rule",
    );
  }
  if (ownField(grant, "outcome") !== "known") return true;
  const actionKind = ownField(value, "actionKind");
  if (isOneOf(actionKind, GOVERNED_ACTION_ACTION_KINDS) && isGovernedActionGrantable(actionKind)) {
    return true;
  }
  return addValidationError(
    errors,
    "grant is not permitted on a structurally ungrantable action kind",
  );
}

function governedActionRefFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  const decision = ownField(value, "decision");
  if (!isOneOf(decision, GOVERNED_ACTION_DECISIONS))
    return addValidationError(errors, "decision is invalid");
  if (decision === "allowed") {
    valid = [
      valid,
      grantRefFactFieldsAreValid(errors, ownField(value, "grant")),
      allowedGrantExclusionFieldsAreValid(errors, value),
      absentFieldsAreValid(errors, ownField(value, "question"), "question"),
    ].every(Boolean);
    return valid;
  }
  if (decision === "approval-required") {
    valid = [
      valid,
      absentFieldsAreValid(errors, ownField(value, "grant"), "grant"),
      questionRefFactFieldsAreValid(errors, ownField(value, "question")),
    ].every(Boolean);
    return valid;
  }
  valid = [
    valid,
    absentFieldsAreValid(errors, ownField(value, "grant"), "grant"),
    absentFieldsAreValid(errors, ownField(value, "question"), "question"),
  ].every(Boolean);
  return valid;
}

function absentFieldsAreValid(errors: string[], value: unknown, path: string): boolean {
  return (
    isAbsent(value) ||
    addValidationError(errors, `${path} must be an explicit { outcome: "absent" } fact`)
  );
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

function admitGovernedActionV1(value: unknown, errors: string[]): value is GovernedActionV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "governed action must be an object");
  // getOwnPropertyNames + no-symbols, matching shared unknownKeys: Object.keys alone misses a
  // non-enumerable own property. isRecord already rejects a non-default prototype.
  valid =
    appendValidationErrors(
      errors,
      Object.getOwnPropertyNames(value)
        .filter((key) => !GOVERNED_ACTION_KEYS.has(key))
        .map((key) => `governedAction.${key} is not allowed`),
    ) && valid;
  if (Object.getOwnPropertySymbols(value).length > 0) {
    valid = addValidationError(errors, "governedAction must not carry symbol-keyed properties");
  }
  valid = envelopeFieldsAreValid(errors, value) && valid;
  if (!isOneOf(ownField(value, "decision"), GOVERNED_ACTION_DECISIONS)) {
    valid = addValidationError(errors, "decision is invalid");
  } else {
    valid = governedActionRefFieldsAreValid(errors, value) && valid;
  }
  return valid;
}

export function validateGovernedActionV1(
  value: unknown,
): CodingWorkbenchValidationResult<GovernedActionV1> {
  const errors: string[] = [];
  return admitGovernedActionV1(value, errors) ? { ok: true, value } : { ok: false, errors };
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

function executionHeaderFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = validateCodeTaskHeaderTags(
    errors,
    value,
    CODE_TASK_EXECUTION_KIND,
    CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
  );
  if (!isCodeTaskTaskId(ownField(value, "taskId")))
    valid = addValidationError(errors, "taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId")))
    valid = addValidationError(errors, "runId is invalid");
  if (!isCodeTaskWorkspaceId(ownField(value, "workspaceId")))
    valid = addValidationError(errors, "workspaceId is invalid");
  return valid;
}

function executionModeFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  for (const key of ["requestedMode", "effectiveMode", "deploymentCeiling"] as const) {
    if (!isOneOf(ownField(value, key), CODING_WORKBENCH_MODES))
      valid = addValidationError(errors, `${key} is invalid`);
  }
  if (!isOneOf(ownField(value, "state"), CODING_WORKBENCH_RUNTIME_STATE_NAMES)) {
    valid = addValidationError(errors, "state is invalid");
  }
  return valid;
}

function executionFactFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  for (const key of ["stateRevision", "runEpoch"] as const) {
    if (!isNonNegativeInteger(ownField(value, key))) {
      valid = addValidationError(errors, `${key} must be a non-negative integer`);
    }
  }
  for (const key of ["objectiveDigest", "authorityEnvelopeDigest"] as const) {
    if (!isCodeTaskSha256Digest(ownField(value, key)))
      valid = addValidationError(errors, `${key} must be a sha256 digest`);
  }
  if (!isCodeTaskIsoInstant(ownField(value, "updatedAt"))) {
    valid = addValidationError(errors, "updatedAt must be an ISO-8601 UTC instant");
  }
  // KEIKO-0626: pass the execution state into the failure-fact validator so the invariant is
  // enforced at parse time — `failed` and `recovery-required` states MUST carry a known failure
  // fact, and every other state MUST carry an absent/unknown/unavailable failure fact.
  valid =
    executionFailureFactFieldsAreValid(
      errors,
      ownField(value, "failure"),
      ownField(value, "state"),
    ) && valid;
  return valid;
}

// KEIKO-0302 follow-on: same gap as grantRefFactErrors/questionRefFactErrors above — the "known"
// branch validated value.value but never rejected an extra key riding alongside it, and the other
// three outcomes only checked for a stray "value" key, not any other extra key. The
// `failure must not carry a value for outcome ${outcome}` message is preserved exactly for that
// one pinned case; every other extra key is now also rejected via unknownKeys.
// Round 3 (#2899): same early-return-vs-collect and per-key-vs-general-guard gaps as
// grantRefFactErrors/questionRefFactErrors above, fixed the same way.
// KEIKO-0626: the failure fact's outcome must correlate with the runtime state — a "failed" or
// "recovery-required" state MUST carry a `known` failure, and every other state MUST carry a
// non-known outcome. Previously the shapes were checked independently, so `state: "running"` with
// `failure: { outcome: "known", value: "..." }` (or the reverse — `state: "failed"` with an
// `absent` failure) validated cleanly.
const FAILURE_STATES: ReadonlySet<string> = new Set(["failed", "recovery-required"]);

function knownFailureFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  state: unknown,
): boolean {
  let valid = true;
  valid = validateCodeTaskOwnKeys(errors, value, ["outcome", "value"], "failure") && valid;
  if (!isContentFreeReasonCode(ownField(value, "value"))) {
    valid = addValidationError(errors, "failure.value must be a bounded content-free reason code");
  }
  if (typeof state === "string" && !FAILURE_STATES.has(state)) {
    valid = addValidationError(
      errors,
      `failure.outcome=known is only valid when state is failed or recovery-required, got ${state}`,
    );
  }
  return valid;
}

function nonKnownFailureFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  outcome: "absent" | "unavailable" | "unknown",
  state: unknown,
): boolean {
  let valid = true;
  valid = validateCodeTaskOwnKeys(errors, value, ["outcome"], "failure") && valid;
  if (Object.hasOwn(value, "value")) {
    valid = addValidationError(errors, `failure must not carry a value for outcome ${outcome}`);
  }
  if (typeof state === "string" && FAILURE_STATES.has(state)) {
    valid = addValidationError(
      errors,
      `failure.outcome=${outcome} is invalid when state is ${state}; expected outcome=known`,
    );
  }
  return valid;
}

function executionObservedStateIsValid(errors: string[], state: unknown): boolean {
  let valid = true;
  if (!isOneOf(state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) {
    valid = false;
    if (!errors.includes("state is invalid")) errors.push("state is invalid");
  }
  return valid;
}

function executionFailureFactFieldsAreValid(
  errors: string[],
  value: unknown,
  state: unknown,
): boolean {
  const valid = executionObservedStateIsValid(errors, state);
  if (!isRecord(value)) return addValidationError(errors, "failure must be a tagged fact object");
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      "failure must not resolve any field through its prototype chain",
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") return knownFailureFactFieldsAreValid(errors, value, state) && valid;
  if (outcome === "absent" || outcome === "unavailable" || outcome === "unknown") {
    return nonKnownFailureFactFieldsAreValid(errors, value, outcome, state) && valid;
  }
  return addValidationError(
    errors,
    "failure.outcome must be known, absent, unavailable, or unknown",
  );
}

function admitCodeTaskExecutionV1(value: unknown, errors: string[]): value is CodeTaskExecutionV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "code-task execution must be an object");
  // getOwnPropertyNames + no-symbols, matching shared unknownKeys: Object.keys alone misses a
  // non-enumerable own property. isRecord already rejects a non-default prototype.
  valid =
    appendValidationErrors(
      errors,
      Object.getOwnPropertyNames(value)
        .filter((key) => !CODE_TASK_EXECUTION_KEYS.has(key))
        .map((key) => `codeTaskExecution.${key} is not allowed`),
    ) && valid;
  if (Object.getOwnPropertySymbols(value).length > 0) {
    valid = addValidationError(errors, "codeTaskExecution must not carry symbol-keyed properties");
  }
  valid = [
    valid,
    executionHeaderFieldsAreValid(errors, value),
    executionModeFieldsAreValid(errors, value),
    executionFactFieldsAreValid(errors, value),
  ].every(Boolean);
  return valid;
}

export function validateCodeTaskExecutionV1(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskExecutionV1> {
  const errors: string[] = [];
  return admitCodeTaskExecutionV1(value, errors) ? { ok: true, value } : { ok: false, errors };
}
