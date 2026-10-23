import { codeTaskParentTargetErrors } from "./code-task-target-validation.js";
// Cross-child run-control contracts for Epic #2384 Code-task children (Issue #2386). Same type
// rule as ./code-task-governance.ts: readonly, JSON-serializable, discriminated unions, literal
// `schemaVersion: 1`, branded ids, explicit tagged-absent facts, content-free payloads.
//
// `RunControlSnapshotV1` is produced for #2389 (durable control state + content-free recovery
// refs). `RuntimeGovernancePortV1` is produced for #2388 (the port over resolve/revalidate/decide
// plus pause/stop/revoke). A missing runtime capability resolves to unsupported or denied — never
// allowed.
import type { CodeTaskFact } from "./code-task-acceptance.js";
import { hasInheritedEnumerableProperty, ownField } from "./code-task-acceptance.js";
import type {
  CodeTaskGrantId,
  CodeTaskGrantScope,
  CodeTaskIdempotencyKey,
  CodeTaskQuestionId,
  CodeTaskRunId,
  CodeTaskTaskId,
  CodeTaskWorkspaceId,
  GovernedActionActionKind,
  GovernedActionDecision,
} from "./code-task-governance.js";
import {
  CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
  GOVERNED_ACTION_ACTION_KINDS,
  GOVERNED_ACTION_DECISIONS,
  isCodeTaskGrantId,
  isCodeTaskGrantScope,
  isCodeTaskIdempotencyKey,
  isCodeTaskQuestionId,
  isCodeTaskRunId,
  isCodeTaskTaskId,
  isContentFreeReasonCode,
} from "./code-task-governance.js";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";

// Matches the hardening in code-task-acceptance.ts/code-task-governance.ts (KfQ Critical): a value
// shaped via Object.create(secretHolder) can carry every required field as an OWN property while
// one extra field rides the prototype chain, invisible to any own-property-only scan. Rejecting any
// non-default prototype closes this at the single choke point every validator in this file already
// passes through. This alone does not defend against a genuinely polluted GLOBAL Object.prototype
// (Object.getPrototypeOf(value) === Object.prototype stays true even after Object.prototype itself
// gains a property, since mutating an object in place never changes its identity) -- that residual
// case is what every ownField(value, key) read below (imported from code-task-acceptance.ts) closes
// completely, rather than the field-specific/enumerable-only checks this file used to have here.
function addValidationError(errors: string[], message: string): false {
  errors.push(message);
  return false;
}

function appendValidationErrors(errors: string[], messages: readonly string[]): boolean {
  errors.push(...messages);
  return messages.length === 0;
}

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
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
}

// Object.getOwnPropertyNames (not Object.keys) plus an own-symbol check, matching the sibling
// files' idiom: Object.keys alone misses a non-enumerable own property. isRecord above rejects a
// non-default prototype; neither closes a genuinely polluted Object.prototype (see its comment).
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

// ─── RunControlSnapshotV1 (produced for #2389) ─────────────────────────────────────
export const RUN_CONTROL_SNAPSHOT_KIND = "run-control-snapshot";

export interface RunControlGrantRefV1 {
  readonly grantId: CodeTaskGrantId;
  readonly grantScope: CodeTaskGrantScope;
}

export interface RunControlSnapshotV1 {
  readonly kind: typeof RUN_CONTROL_SNAPSHOT_KIND;
  readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
  readonly taskId: CodeTaskTaskId;
  readonly runId: CodeTaskRunId;
  readonly runEpoch: number;
  readonly stateRevision: number;
  readonly idempotencyKey: CodeTaskIdempotencyKey;
  /** Live task grants bound to this run; an empty array is a valid, explicit "no grants" state. */
  readonly grantRefs: readonly RunControlGrantRefV1[];
  /** Content-free recovery handle; a transient body is omitted with an explicit tagged fact. */
  readonly recoveryRef: CodeTaskFact<string>;
  /** Present only while a required question halts the run; otherwise an explicit absent fact. */
  readonly pendingQuestion: CodeTaskFact<CodeTaskQuestionId>;
}

const RUN_CONTROL_SNAPSHOT_KEYS = [
  "kind",
  "schemaVersion",
  "taskId",
  "runId",
  "runEpoch",
  "stateRevision",
  "idempotencyKey",
  "grantRefs",
  "recoveryRef",
  "pendingQuestion",
];

function grantRefFieldsAreValid(errors: string[], value: unknown, index: number): boolean {
  let valid = true;
  if (!isRecord(value))
    return addValidationError(errors, `grantRefs[${String(index)}] must be an object`);
  valid =
    appendValidationErrors(
      errors,
      unknownKeys(value, ["grantId", "grantScope"], `grantRefs[${String(index)}]`),
    ) && valid;
  if (!isCodeTaskGrantId(ownField(value, "grantId"))) {
    valid = addValidationError(errors, `grantRefs[${String(index)}].grantId is invalid`);
  }
  if (!isCodeTaskGrantScope(ownField(value, "grantScope"))) {
    valid = addValidationError(errors, `grantRefs[${String(index)}].grantScope is invalid`);
  }
  return valid;
}

// KEIKO-0302 follow-on: the "known" branch checked `value` but never the fact object's OWN keys,
// so a well-formed known fact padded with an extra field (e.g. free text riding alongside a valid
// handle) validated and was returned verbatim.
// hasInheritedEnumerableProperty and ownField are imported from code-task-acceptance.ts, not
// reimplemented here: see their definitions there for the full history (Codex P1 3789537202,
// 3789635890, 3789773829) and why gating every read through ownField -- not detecting a specific
// inherited-property shape -- is the fix that terminates the whack-a-mole rather than adding
// another round to it. This file used to keep its own duplicate hasInheritedEnumerableProperty;
// consolidated on the ownField rewrite since arch:check already proved the cross-file import is
// clean for the sibling files touched in the same change.
function boundedStringFactKnownFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
): boolean {
  let valid = true;
  // Collected, not early-returned (KfQ 3789542365's shape, fixed consistently here too): an
  // object can carry both an extra own key and an invalid value, and both are worth reporting.
  valid = appendValidationErrors(errors, unknownKeys(value, ["outcome", "value"], path)) && valid;
  // recoveryRef is documented as a content-free handle, so it takes the same lower-kebab shape
  // rather than a bare length bound that a filesystem path would pass.
  if (!isContentFreeReasonCode(ownField(value, "value"))) {
    valid = addValidationError(errors, `${path}.value must be a bounded content-free reference`);
  }
  return valid;
}

function boundedStringFactFieldsAreValid(errors: string[], value: unknown, path: string): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be a tagged fact object`);
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      `${path} must not resolve any field through its prototype chain`,
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") return boundedStringFactKnownFieldsAreValid(errors, value, path);
  if (outcome === "absent" || outcome === "unavailable" || outcome === "unknown") {
    valid = appendValidationErrors(errors, unknownKeys(value, ["outcome"], path)) && valid;
    if (Object.hasOwn(value, "value")) {
      valid = addValidationError(errors, `${path} must not carry a value for outcome ${outcome}`);
    }
    return valid;
  }
  return addValidationError(
    errors,
    `${path}.outcome must be known, absent, unavailable, or unknown`,
  );
}

function questionFactKnownFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  let valid = true;
  valid =
    appendValidationErrors(errors, unknownKeys(value, ["outcome", "value"], "pendingQuestion")) &&
    valid;
  if (!isCodeTaskQuestionId(ownField(value, "value"))) {
    valid = addValidationError(errors, "pendingQuestion.value must be a question id");
  }
  return valid;
}

function questionFactFieldsAreValid(errors: string[], value: unknown): boolean {
  let valid = true;
  if (!isRecord(value))
    return addValidationError(errors, "pendingQuestion must be a tagged fact object");
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      "pendingQuestion must not resolve any field through its prototype chain",
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") return questionFactKnownFieldsAreValid(errors, value);
  if (outcome === "absent" || outcome === "unavailable" || outcome === "unknown") {
    valid =
      appendValidationErrors(errors, unknownKeys(value, ["outcome"], "pendingQuestion")) && valid;
    if (Object.hasOwn(value, "value")) {
      valid = addValidationError(
        errors,
        `pendingQuestion must not carry a value for outcome ${outcome}`,
      );
    }
    return valid;
  }
  return addValidationError(
    errors,
    "pendingQuestion.outcome must be known, absent, unavailable, or unknown",
  );
}

function runControlHeaderFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  if (ownField(value, "kind") !== RUN_CONTROL_SNAPSHOT_KIND) {
    valid = addValidationError(errors, `kind must be ${RUN_CONTROL_SNAPSHOT_KIND}`);
  }
  if (ownField(value, "schemaVersion") !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(ownField(value, "taskId")))
    valid = addValidationError(errors, "taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId")))
    valid = addValidationError(errors, "runId is invalid");
  if (!isCodeTaskIdempotencyKey(ownField(value, "idempotencyKey"))) {
    valid = addValidationError(errors, "idempotencyKey is invalid");
  }
  for (const key of ["runEpoch", "stateRevision"] as const) {
    if (!isNonNegativeInteger(ownField(value, key))) {
      valid = addValidationError(errors, `${key} must be a non-negative integer`);
    }
  }
  return valid;
}

function admitRunControlSnapshotV1(
  value: unknown,
  errors: string[],
): value is RunControlSnapshotV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "run-control snapshot must be an object");
  valid =
    appendValidationErrors(
      errors,
      unknownKeys(value, RUN_CONTROL_SNAPSHOT_KEYS, "runControlSnapshot"),
    ) && valid;
  valid = runControlHeaderFieldsAreValid(errors, value) && valid;
  const grantRefs = ownField(value, "grantRefs");
  if (Array.isArray(grantRefs)) {
    const entries: readonly unknown[] = grantRefs;
    const length = entries.length;
    for (let index = 0; index < length; index += 1) {
      if (!(index in entries)) {
        valid = addValidationError(errors, `grantRefs[${String(index)}] must be an object`);
        break;
      }
      const ref: unknown = entries[index];
      valid = grantRefFieldsAreValid(errors, ref, index) && valid;
    }
  } else {
    valid = addValidationError(errors, "grantRefs must be an array");
  }
  valid = [
    valid,
    boundedStringFactFieldsAreValid(errors, ownField(value, "recoveryRef"), "recoveryRef"),
    questionFactFieldsAreValid(errors, ownField(value, "pendingQuestion")),
  ].every(Boolean);
  return valid;
}

export function validateRunControlSnapshotV1(
  value: unknown,
): CodingWorkbenchValidationResult<RunControlSnapshotV1> {
  const errors: string[] = [];
  return admitRunControlSnapshotV1(value, errors) ? { ok: true, value } : { ok: false, errors };
}

// ─── RuntimeGovernancePortV1 (produced for #2388) ──────────────────────────────────
export const RUNTIME_GOVERNANCE_OPERATIONS = Object.freeze([
  "resolve",
  "revalidate",
  "decide",
  "pause",
  "stop",
  "revoke",
] as const);
export type RuntimeGovernanceOperation = (typeof RUNTIME_GOVERNANCE_OPERATIONS)[number];

export interface RuntimeGovernanceTarget {
  readonly taskId: CodeTaskTaskId;
  readonly runId: CodeTaskRunId;
  readonly workspaceId: CodeTaskWorkspaceId;
  readonly stateRevision: number;
  readonly idempotencyKey: CodeTaskIdempotencyKey;
}

/** Discriminated on `operation`; only "decide" carries a normalized action to admit. */
export type RuntimeGovernanceRequestV1 =
  | (RuntimeGovernanceTarget & {
      readonly operation: "decide";
      readonly actionKind: GovernedActionActionKind;
      readonly requestedGrantScope: CodeTaskGrantScope;
    })
  | (RuntimeGovernanceTarget & {
      readonly operation: Exclude<RuntimeGovernanceOperation, "decide">;
    });

export const RUNTIME_GOVERNANCE_LIFECYCLE_KINDS = Object.freeze([
  "paused",
  "resumed",
  "mutation-halted",
  "stopping",
  "stopped",
  "revoked",
  "lease-dropped",
] as const);
export type RuntimeGovernanceLifecycleKind = (typeof RUNTIME_GOVERNANCE_LIFECYCLE_KINDS)[number];

export interface RuntimeGovernanceLifecycleEventV1 {
  readonly sequence: number;
  readonly kind: RuntimeGovernanceLifecycleKind;
  readonly stateRevision: number;
}

export const RUNTIME_GOVERNANCE_OUTCOME_STATUSES = Object.freeze([
  "decided",
  "settled",
  "unsupported",
  "denied",
] as const);
export type RuntimeGovernanceOutcomeStatus = (typeof RUNTIME_GOVERNANCE_OUTCOME_STATUSES)[number];

/**
 * Discriminated on `status`. "decided" carries a normalized `GovernedActionDecision`; "settled"
 * carries the ordered lifecycle events of a pause/stop/revoke; "unsupported" and "denied" are the
 * only fail-closed outcomes for a missing capability — they never imply allow.
 */
export type RuntimeGovernanceOutcomeV1 =
  | {
      readonly kind: "runtime-governance-outcome";
      readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
      readonly status: "decided";
      readonly decision: GovernedActionDecision;
    }
  | {
      readonly kind: "runtime-governance-outcome";
      readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
      readonly status: "settled";
      readonly events: readonly RuntimeGovernanceLifecycleEventV1[];
    }
  | {
      readonly kind: "runtime-governance-outcome";
      readonly schemaVersion: typeof CODE_TASK_GOVERNANCE_SCHEMA_VERSION;
      readonly status: "unsupported" | "denied";
      readonly reasonCode: string;
    };

/** The port interface. Not JSON-serializable itself; its inputs and outputs are the contracts. */
export interface RuntimeGovernancePortV1 {
  readonly govern: (request: RuntimeGovernanceRequestV1) => Promise<RuntimeGovernanceOutcomeV1>;
}

function targetFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  valid = appendValidationErrors(errors, codeTaskParentTargetErrors(value)) && valid;
  if (!isCodeTaskIdempotencyKey(ownField(value, "idempotencyKey"))) {
    valid = addValidationError(errors, "idempotencyKey is invalid");
  }
  return valid;
}

const RUNTIME_GOVERNANCE_TARGET_KEYS = [
  "operation",
  "taskId",
  "runId",
  "workspaceId",
  "stateRevision",
  "idempotencyKey",
];

function requestOperationFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  const operation = ownField(value, "operation");
  if (!isOneOf(operation, RUNTIME_GOVERNANCE_OPERATIONS))
    return addValidationError(errors, "operation is invalid");
  if (operation === "decide") {
    valid =
      appendValidationErrors(
        errors,
        unknownKeys(
          value,
          [...RUNTIME_GOVERNANCE_TARGET_KEYS, "actionKind", "requestedGrantScope"],
          "runtimeGovernanceRequest",
        ),
      ) && valid;
    if (!isOneOf(ownField(value, "actionKind"), GOVERNED_ACTION_ACTION_KINDS)) {
      valid = addValidationError(errors, "actionKind is invalid");
    }
    if (!isCodeTaskGrantScope(ownField(value, "requestedGrantScope"))) {
      valid = addValidationError(errors, "requestedGrantScope is invalid");
    }
    return valid;
  }
  return appendValidationErrors(
    errors,
    unknownKeys(value, RUNTIME_GOVERNANCE_TARGET_KEYS, "runtimeGovernanceRequest"),
  );
}

function admitRuntimeGovernanceRequestV1(
  value: unknown,
  errors: string[],
): value is RuntimeGovernanceRequestV1 {
  let valid = true;
  if (!isRecord(value))
    return addValidationError(errors, "runtime governance request must be an object");

  if (!isOneOf(ownField(value, "operation"), RUNTIME_GOVERNANCE_OPERATIONS)) {
    valid = addValidationError(errors, "operation is invalid");
  } else {
    valid = requestOperationFieldsAreValid(errors, value) && valid;
  }
  valid = targetFieldsAreValid(errors, value) && valid;
  return valid;
}

export function validateRuntimeGovernanceRequestV1(
  value: unknown,
): CodingWorkbenchValidationResult<RuntimeGovernanceRequestV1> {
  const errors: string[] = [];
  return admitRuntimeGovernanceRequestV1(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function lifecycleEventFieldsAreValid(errors: string[], value: unknown, index: number): boolean {
  let valid = true;
  if (!isRecord(value))
    return addValidationError(errors, `events[${String(index)}] must be an object`);
  valid =
    appendValidationErrors(
      errors,
      unknownKeys(value, ["sequence", "kind", "stateRevision"], `events[${String(index)}]`),
    ) && valid;
  for (const key of ["sequence", "stateRevision"] as const) {
    if (!isNonNegativeInteger(ownField(value, key))) {
      valid = addValidationError(
        errors,
        `events[${String(index)}].${key} must be a non-negative integer`,
      );
    }
  }
  if (!isOneOf(ownField(value, "kind"), RUNTIME_GOVERNANCE_LIFECYCLE_KINDS)) {
    valid = addValidationError(errors, `events[${String(index)}].kind is invalid`);
  }
  return valid;
}

function outcomeLifecycleFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  const events = ownField(value, "events");
  if (Array.isArray(events)) {
    const entries: readonly unknown[] = events;
    const length = entries.length;
    for (let index = 0; index < length; index += 1) {
      if (!(index in entries)) {
        valid = addValidationError(errors, `events[${String(index)}] must be an object`);
        break;
      }
      const event: unknown = entries[index];
      valid = lifecycleEventFieldsAreValid(errors, event, index) && valid;
    }
  } else {
    valid = addValidationError(errors, "events must be an array");
  }
  return valid;
}

function outcomeBodyFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  const status = ownField(value, "status");
  if (!isOneOf(status, RUNTIME_GOVERNANCE_OUTCOME_STATUSES))
    return addValidationError(errors, "status is invalid");
  if (status === "decided") {
    valid =
      appendValidationErrors(
        errors,
        unknownKeys(value, ["kind", "schemaVersion", "status", "decision"], "outcome"),
      ) && valid;
    if (!isOneOf(ownField(value, "decision"), GOVERNED_ACTION_DECISIONS)) {
      valid = addValidationError(errors, "decision is invalid");
    }
    return valid;
  }
  if (status === "settled") {
    valid =
      appendValidationErrors(
        errors,
        unknownKeys(value, ["kind", "schemaVersion", "status", "events"], "outcome"),
      ) && valid;
    valid = outcomeLifecycleFieldsAreValid(errors, value) && valid;
    return valid;
  }
  valid =
    appendValidationErrors(
      errors,
      unknownKeys(value, ["kind", "schemaVersion", "status", "reasonCode"], "outcome"),
    ) && valid;
  // Length alone is not content-freeness: "Denied: /Users/alice/secret" is well under 64 characters.
  // The shared lower-kebab predicate is the rule this message already claims to enforce.
  if (!isContentFreeReasonCode(ownField(value, "reasonCode"))) {
    valid = addValidationError(errors, "reasonCode must be a bounded content-free reason code");
  }
  return valid;
}

function admitRuntimeGovernanceOutcomeV1(
  value: unknown,
  errors: string[],
): value is RuntimeGovernanceOutcomeV1 {
  let valid = true;
  if (!isRecord(value))
    return addValidationError(errors, "runtime governance outcome must be an object");

  if (ownField(value, "kind") !== "runtime-governance-outcome")
    valid = addValidationError(errors, "kind is invalid");
  if (ownField(value, "schemaVersion") !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  if (!isOneOf(ownField(value, "status"), RUNTIME_GOVERNANCE_OUTCOME_STATUSES)) {
    valid = addValidationError(errors, "status is invalid");
  } else {
    valid = outcomeBodyFieldsAreValid(errors, value) && valid;
  }
  return valid;
}

export function validateRuntimeGovernanceOutcomeV1(
  value: unknown,
): CodingWorkbenchValidationResult<RuntimeGovernanceOutcomeV1> {
  const errors: string[] = [];
  return admitRuntimeGovernanceOutcomeV1(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}
