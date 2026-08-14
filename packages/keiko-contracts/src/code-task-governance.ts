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
import { isCodeTaskIsoInstant, isCodeTaskSha256Digest } from "./code-task-acceptance.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
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
  if (value.kind !== GOVERNED_ACTION_KIND) errors.push(`kind must be ${GOVERNED_ACTION_KIND}`);
  if (value.schemaVersion !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(value.taskId)) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(value.runId)) errors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(value.workspaceId)) errors.push("workspaceId is invalid");
  if (!isNonNegativeInteger(value.stateRevision)) {
    errors.push("stateRevision must be a non-negative integer");
  }
  if (!isOneOf(value.actionKind, GOVERNED_ACTION_ACTION_KINDS))
    errors.push("actionKind is invalid");
  return errors;
}

function isAbsent(value: unknown): value is GovernedActionAbsent {
  return isRecord(value) && value.outcome === "absent" && !("value" in value);
}

function grantRefFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["grant must be a tagged fact object"];
  if (value.outcome === "absent") return "value" in value ? ["grant must not carry a value"] : [];
  if (value.outcome !== "known") return ["grant.outcome must be known or absent"];
  const grant = value.value;
  if (!isRecord(grant)) return ["grant.value must be an object"];
  const errors = unknownKeys(grant, ["grantId", "grantScope"], "grant.value");
  if (!isCodeTaskGrantId(grant.grantId)) errors.push("grant.value.grantId is invalid");
  if (!isCodeTaskGrantScope(grant.grantScope)) errors.push("grant.value.grantScope is invalid");
  return errors;
}

function questionRefFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["question must be a tagged fact object"];
  if (value.outcome === "absent") {
    return "value" in value ? ["question must not carry a value"] : [];
  }
  if (value.outcome !== "known") return ["question.outcome must be known or absent"];
  const question = value.value;
  if (!isRecord(question)) return ["question.value must be an object"];
  const errors = unknownKeys(question, ["questionId", "expectedRevision"], "question.value");
  if (!isCodeTaskQuestionId(question.questionId))
    errors.push("question.value.questionId is invalid");
  if (!isNonNegativeInteger(question.expectedRevision)) {
    errors.push("question.value.expectedRevision must be a non-negative integer");
  }
  return errors;
}

// A "known" grant on an ungrantable action kind (delivery, authority-widening, dependency-operation,
// external-file-apply-back) is rejected: those actions can never be covered by a stored grant and
// require separate explicit approval every time (the structural exclusion invariant).
function allowedGrantExclusionErrors(value: Record<string, unknown>): string[] {
  const grant = value.grant;
  if (!isRecord(grant) || grant.outcome !== "known") return [];
  if (
    isOneOf(value.actionKind, GOVERNED_ACTION_ACTION_KINDS) &&
    isGovernedActionGrantable(value.actionKind)
  ) {
    return [];
  }
  return ["grant is not permitted on a structurally ungrantable action kind"];
}

function governedActionRefErrors(value: Record<string, unknown>): string[] {
  if (value.decision === "allowed") {
    return [
      ...grantRefFactErrors(value.grant),
      ...allowedGrantExclusionErrors(value),
      ...absentErrors(value.question, "question"),
    ];
  }
  if (value.decision === "approval-required") {
    return [...absentErrors(value.grant, "grant"), ...questionRefFactErrors(value.question)];
  }
  return [...absentErrors(value.grant, "grant"), ...absentErrors(value.question, "question")];
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
  const errors = Object.keys(value)
    .filter((key) => !GOVERNED_ACTION_KEYS.has(key))
    .map((key) => `governedAction.${key} is not allowed`);
  errors.push(...envelopeErrors(value));
  if (!isOneOf(value.decision, GOVERNED_ACTION_DECISIONS)) errors.push("decision is invalid");
  else errors.push(...governedActionRefErrors(value));
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
  if (value.kind !== CODE_TASK_EXECUTION_KIND)
    errors.push(`kind must be ${CODE_TASK_EXECUTION_KIND}`);
  if (value.schemaVersion !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(value.taskId)) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(value.runId)) errors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(value.workspaceId)) errors.push("workspaceId is invalid");
  return errors;
}

function executionModeErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["requestedMode", "effectiveMode", "deploymentCeiling"] as const) {
    if (!isOneOf(value[key], CODING_WORKBENCH_MODES)) errors.push(`${key} is invalid`);
  }
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) errors.push("state is invalid");
  return errors;
}

function executionFactErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["stateRevision", "runEpoch"] as const) {
    if (!isNonNegativeInteger(value[key])) errors.push(`${key} must be a non-negative integer`);
  }
  for (const key of ["objectiveDigest", "authorityEnvelopeDigest"] as const) {
    if (!isCodeTaskSha256Digest(value[key])) errors.push(`${key} must be a sha256 digest`);
  }
  if (!isCodeTaskIsoInstant(value.updatedAt))
    errors.push("updatedAt must be an ISO-8601 UTC instant");
  errors.push(...executionFailureFactErrors(value.failure));
  return errors;
}

function executionFailureFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["failure must be a tagged fact object"];
  if (value.outcome === "known") {
    return isContentFreeReasonCode(value.value)
      ? []
      : ["failure.value must be a bounded content-free reason code"];
  }
  if (
    value.outcome === "absent" ||
    value.outcome === "unavailable" ||
    value.outcome === "unknown"
  ) {
    return "value" in value ? [`failure must not carry a value for outcome ${value.outcome}`] : [];
  }
  return ["failure.outcome must be known, absent, unavailable, or unknown"];
}

export function validateCodeTaskExecutionV1(
  value: unknown,
): CodingWorkbenchValidationResult<CodeTaskExecutionV1> {
  if (!isRecord(value)) return { ok: false, errors: ["code-task execution must be an object"] };
  const errors = Object.keys(value)
    .filter((key) => !CODE_TASK_EXECUTION_KEYS.has(key))
    .map((key) => `codeTaskExecution.${key} is not allowed`);
  errors.push(
    ...executionHeaderErrors(value),
    ...executionModeErrors(value),
    ...executionFactErrors(value),
  );
  return errors.length === 0
    ? { ok: true, value: value as unknown as CodeTaskExecutionV1 }
    : { ok: false, errors };
}
