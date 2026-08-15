// Cross-child run-control contracts for Epic #2384 Code-task children (Issue #2386). Same type
// rule as ./code-task-governance.ts: readonly, JSON-serializable, discriminated unions, literal
// `schemaVersion: 1`, branded ids, explicit tagged-absent facts, content-free payloads.
//
// `RunControlSnapshotV1` is produced for #2389 (durable control state + content-free recovery
// refs). `RuntimeGovernancePortV1` is produced for #2388 (the port over resolve/revalidate/decide
// plus pause/stop/revoke). A missing runtime capability resolves to unsupported or denied — never
// allowed.
import type { CodeTaskFact } from "./code-task-acceptance.js";
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
  isCodeTaskWorkspaceId,
  isContentFreeReasonCode,
} from "./code-task-governance.js";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";

// Matches the hardening in code-task-acceptance.ts/code-task-governance.ts (KfQ Critical): a value
// shaped via Object.create(secretHolder) can carry every required field as an OWN property while
// one extra field rides the prototype chain, invisible to any own-property-only scan. Rejecting any
// non-default prototype closes this at the single choke point every validator in this file already
// passes through. This alone does not defend against a genuinely polluted GLOBAL Object.prototype
// (Object.getPrototypeOf(value) === Object.prototype stays true even after Object.prototype itself
// gains a property, since mutating an object in place never changes its identity) -- that case is
// what the "value" in value / "in" checks below independently exist for.
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

function grantRefErrors(value: unknown, index: number): string[] {
  if (!isRecord(value)) return [`grantRefs[${String(index)}] must be an object`];
  const errors = unknownKeys(value, ["grantId", "grantScope"], `grantRefs[${String(index)}]`);
  if (!isCodeTaskGrantId(value.grantId))
    errors.push(`grantRefs[${String(index)}].grantId is invalid`);
  if (!isCodeTaskGrantScope(value.grantScope)) {
    errors.push(`grantRefs[${String(index)}].grantScope is invalid`);
  }
  return errors;
}

// KEIKO-0302 follow-on: the "known" branch checked `value` but never the fact object's OWN keys,
// so a well-formed known fact padded with an extra field (e.g. free text riding alongside a valid
// handle) validated and was returned verbatim.
function boundedStringFactErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be a tagged fact object`];
  if (value.outcome === "known") {
    const extraKeys = unknownKeys(value, ["outcome", "value"], path);
    if (extraKeys.length > 0) return extraKeys;
    // recoveryRef is documented as a content-free handle, so it takes the same lower-kebab shape
    // rather than a bare length bound that a filesystem path would pass.
    return isContentFreeReasonCode(value.value)
      ? []
      : [`${path}.value must be a bounded content-free reference`];
  }
  if (
    value.outcome === "absent" ||
    value.outcome === "unavailable" ||
    value.outcome === "unknown"
  ) {
    // Codex P1: this "in" check was dropped in favour of unknownKeys alone, which only scans OWN
    // properties -- an Object.create({ value: "secret" })-backed fact with just an own
    // `outcome: "absent"` then passed with no errors. "in" walks the prototype chain, which is the
    // point here (contrast debug-lifecycle.ts, where the same operator is wrong for a different
    // question -- "is this key an approved set member" -- because it would also accept
    // "constructor"). Restored alongside unknownKeys, not instead of it: unknownKeys still catches
    // any OTHER extra key this outcome must not carry.
    if ("value" in value) return [`${path} must not carry a value for outcome ${value.outcome}`];
    return unknownKeys(value, ["outcome"], path);
  }
  return [`${path}.outcome must be known, absent, unavailable, or unknown`];
}

function questionFactErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["pendingQuestion must be a tagged fact object"];
  if (value.outcome === "known") {
    const extraKeys = unknownKeys(value, ["outcome", "value"], "pendingQuestion");
    if (extraKeys.length > 0) return extraKeys;
    return isCodeTaskQuestionId(value.value) ? [] : ["pendingQuestion.value must be a question id"];
  }
  if (
    value.outcome === "absent" ||
    value.outcome === "unavailable" ||
    value.outcome === "unknown"
  ) {
    // Same regression, same fix as boundedStringFactErrors above: "in" walks the prototype chain,
    // which unknownKeys's own-property scan alone cannot.
    if ("value" in value) {
      return [`pendingQuestion must not carry a value for outcome ${value.outcome}`];
    }
    return unknownKeys(value, ["outcome"], "pendingQuestion");
  }
  return ["pendingQuestion.outcome must be known, absent, unavailable, or unknown"];
}

function runControlHeaderErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.kind !== RUN_CONTROL_SNAPSHOT_KIND) {
    errors.push(`kind must be ${RUN_CONTROL_SNAPSHOT_KIND}`);
  }
  if (value.schemaVersion !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskTaskId(value.taskId)) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(value.runId)) errors.push("runId is invalid");
  if (!isCodeTaskIdempotencyKey(value.idempotencyKey)) errors.push("idempotencyKey is invalid");
  for (const key of ["runEpoch", "stateRevision"] as const) {
    if (!isNonNegativeInteger(value[key])) errors.push(`${key} must be a non-negative integer`);
  }
  return errors;
}

export function validateRunControlSnapshotV1(
  value: unknown,
): CodingWorkbenchValidationResult<RunControlSnapshotV1> {
  if (!isRecord(value)) return { ok: false, errors: ["run-control snapshot must be an object"] };
  const errors = unknownKeys(value, RUN_CONTROL_SNAPSHOT_KEYS, "runControlSnapshot");
  errors.push(...runControlHeaderErrors(value));
  if (Array.isArray(value.grantRefs)) {
    value.grantRefs.forEach((ref, index) => errors.push(...grantRefErrors(ref, index)));
  } else {
    errors.push("grantRefs must be an array");
  }
  errors.push(
    ...boundedStringFactErrors(value.recoveryRef, "recoveryRef"),
    ...questionFactErrors(value.pendingQuestion),
  );
  return errors.length === 0
    ? { ok: true, value: value as unknown as RunControlSnapshotV1 }
    : { ok: false, errors };
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

function targetErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isCodeTaskTaskId(value.taskId)) errors.push("taskId is invalid");
  if (!isCodeTaskRunId(value.runId)) errors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(value.workspaceId)) errors.push("workspaceId is invalid");
  if (!isNonNegativeInteger(value.stateRevision)) {
    errors.push("stateRevision must be a non-negative integer");
  }
  if (!isCodeTaskIdempotencyKey(value.idempotencyKey)) errors.push("idempotencyKey is invalid");
  return errors;
}

const RUNTIME_GOVERNANCE_TARGET_KEYS = [
  "operation",
  "taskId",
  "runId",
  "workspaceId",
  "stateRevision",
  "idempotencyKey",
];

function requestOperationErrors(value: Record<string, unknown>): string[] {
  if (value.operation === "decide") {
    const errors = unknownKeys(
      value,
      [...RUNTIME_GOVERNANCE_TARGET_KEYS, "actionKind", "requestedGrantScope"],
      "runtimeGovernanceRequest",
    );
    if (!isOneOf(value.actionKind, GOVERNED_ACTION_ACTION_KINDS))
      errors.push("actionKind is invalid");
    if (!isCodeTaskGrantScope(value.requestedGrantScope)) {
      errors.push("requestedGrantScope is invalid");
    }
    return errors;
  }
  return unknownKeys(value, RUNTIME_GOVERNANCE_TARGET_KEYS, "runtimeGovernanceRequest");
}

export function validateRuntimeGovernanceRequestV1(
  value: unknown,
): CodingWorkbenchValidationResult<RuntimeGovernanceRequestV1> {
  if (!isRecord(value))
    return { ok: false, errors: ["runtime governance request must be an object"] };
  const errors: string[] = [];
  if (!isOneOf(value.operation, RUNTIME_GOVERNANCE_OPERATIONS)) errors.push("operation is invalid");
  else errors.push(...requestOperationErrors(value));
  errors.push(...targetErrors(value));
  return errors.length === 0
    ? { ok: true, value: value as unknown as RuntimeGovernanceRequestV1 }
    : { ok: false, errors };
}

function lifecycleEventErrors(value: unknown, index: number): string[] {
  if (!isRecord(value)) return [`events[${String(index)}] must be an object`];
  const errors = unknownKeys(
    value,
    ["sequence", "kind", "stateRevision"],
    `events[${String(index)}]`,
  );
  for (const key of ["sequence", "stateRevision"] as const) {
    if (!isNonNegativeInteger(value[key])) {
      errors.push(`events[${String(index)}].${key} must be a non-negative integer`);
    }
  }
  if (!isOneOf(value.kind, RUNTIME_GOVERNANCE_LIFECYCLE_KINDS)) {
    errors.push(`events[${String(index)}].kind is invalid`);
  }
  return errors;
}

function outcomeBodyErrors(value: Record<string, unknown>): string[] {
  if (value.status === "decided") {
    const errors = unknownKeys(value, ["kind", "schemaVersion", "status", "decision"], "outcome");
    if (!isOneOf(value.decision, GOVERNED_ACTION_DECISIONS)) errors.push("decision is invalid");
    return errors;
  }
  if (value.status === "settled") {
    const errors = unknownKeys(value, ["kind", "schemaVersion", "status", "events"], "outcome");
    if (Array.isArray(value.events)) {
      value.events.forEach((event, index) => errors.push(...lifecycleEventErrors(event, index)));
    } else {
      errors.push("events must be an array");
    }
    return errors;
  }
  const errors = unknownKeys(value, ["kind", "schemaVersion", "status", "reasonCode"], "outcome");
  // Length alone is not content-freeness: "Denied: /Users/alice/secret" is well under 64 characters.
  // The shared lower-kebab predicate is the rule this message already claims to enforce.
  if (!isContentFreeReasonCode(value.reasonCode)) {
    errors.push("reasonCode must be a bounded content-free reason code");
  }
  return errors;
}

export function validateRuntimeGovernanceOutcomeV1(
  value: unknown,
): CodingWorkbenchValidationResult<RuntimeGovernanceOutcomeV1> {
  if (!isRecord(value))
    return { ok: false, errors: ["runtime governance outcome must be an object"] };
  const errors: string[] = [];
  if (value.kind !== "runtime-governance-outcome") errors.push("kind is invalid");
  if (value.schemaVersion !== CODE_TASK_GOVERNANCE_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isOneOf(value.status, RUNTIME_GOVERNANCE_OUTCOME_STATUSES)) errors.push("status is invalid");
  else errors.push(...outcomeBodyErrors(value));
  return errors.length === 0
    ? { ok: true, value: value as unknown as RuntimeGovernanceOutcomeV1 }
    : { ok: false, errors };
}
