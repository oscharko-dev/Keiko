// Cross-child auxiliary-capability contract for Epic #2384 Code tasks (Issue #2387, produced for
// #2388). `AuxiliaryCapabilityPortV1` is the acceptance boundary through which a Code task requests
// exactly one bounded, read-only auxiliary capability — public research, an approved skill, or a
// one-layer read-only child agent — and receives a normalized outcome plus content-free lifecycle
// event refs. It is the strictly-narrower companion to `GovernedActionV1`: an auxiliary request can
// never mint a grant, widen authority, mutate the workspace, deliver Git state, or nest a second
// child. Every value is a readonly, JSON-serializable discriminated union with literal
// `schemaVersion: 1`; identity values reuse the branded opaque ids from `code-task-governance.ts`;
// optional facts use an explicit tagged outcome, never `undefined`. Payloads are content-free: ids,
// digests, counts, bounded reason codes, and validated public domains only — never raw pages,
// prompts, queries beyond the sanitized visible text digest, child scratch, tool bodies, or secrets.
import type { CodeTaskFact } from "./code-task-acceptance.js";
import { isCodeTaskSha256Digest } from "./code-task-acceptance.js";
import type {
  CodeTaskGrantId,
  CodeTaskIdempotencyKey,
  CodeTaskRunId,
  CodeTaskTaskId,
  CodeTaskWorkspaceId,
} from "./code-task-governance.js";
import {
  isCodeTaskGrantId,
  isCodeTaskIdempotencyKey,
  isCodeTaskRunId,
  isCodeTaskTaskId,
  isCodeTaskWorkspaceId,
} from "./code-task-governance.js";
import { CODING_WORKBENCH_AUXILIARY_STATUSES } from "./coding-workbench.js";
import type {
  CodingWorkbenchAuxiliaryStatus,
  CodingWorkbenchValidationResult,
} from "./coding-workbench.js";

export const CODE_TASK_AUXILIARY_SCHEMA_VERSION = 1;

declare const codeTaskAuxiliaryBrand: unique symbol;

/** Type-level brand; branded values stay JSON-serializable primitive strings at runtime. */
export type CodeTaskAuxiliaryBranded<Name extends string> = string & {
  readonly [codeTaskAuxiliaryBrand]: Name;
};

/** Server-approved skill identity (id@version); never a user-authored or runtime-minted skill. */
export type CodeTaskSkillId = CodeTaskAuxiliaryBranded<"CodeTaskSkillId">;
/** A one-layer read-only child agent run id, distinct from the parent run id. */
export type CodeTaskChildRunId = CodeTaskAuxiliaryBranded<"CodeTaskChildRunId">;

const SKILL_ID_PATTERN = /^skl_[a-z0-9][a-z0-9-]{0,62}@\d{1,4}(?:\.\d{1,4}){0,2}$/u;
const CHILD_RUN_ID_PATTERN = /^chr_[A-Za-z0-9_-]{1,251}$/u;
// A validated public domain: lower-case labels, no scheme, port, path, credentials, or IP literal.
// IP literals and loopback names are rejected here so a grant can only ever name a public host; the
// server still re-validates the resolved address at fetch time (SSRF defence in depth).
const PUBLIC_DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/u;
// IPv4 dotted-quad only, with a fixed (non-backtracking) structure. An IPv6 literal contains ":",
// which PUBLIC_DOMAIN_PATTERN (letters, digits, hyphen, dot only) already rejects before this check
// runs, so no separate IPv6 alternative is needed here — and including one (`[0-9a-f:]*:[0-9a-f:]*`)
// introduced a polynomial-time ReDoS on ":"-heavy input flagged by CodeQL. This pattern cannot
// backtrack super-linearly.
const IP_LITERAL_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const RESERVED_DOMAIN_NAMES = Object.freeze(["localhost", "localhost.localdomain"]);
// Content-free bounded reason code (mirrors the code-task-governance content-free rule).
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function isCodeTaskSkillId(value: unknown): value is CodeTaskSkillId {
  return typeof value === "string" && SKILL_ID_PATTERN.test(value);
}

export function isCodeTaskChildRunId(value: unknown): value is CodeTaskChildRunId {
  return typeof value === "string" && CHILD_RUN_ID_PATTERN.test(value);
}

function isCanonicalUrlHostname(value: string): boolean {
  try {
    return new URL(`http://${value}`).hostname === value;
  } catch {
    return false;
  }
}

export function isCodeTaskPublicDomain(value: unknown): value is string {
  if (typeof value !== "string" || !PUBLIC_DOMAIN_PATTERN.test(value)) return false;
  // WHATWG canonicalizes every legacy IPv4 spelling (for example 127.1, octal 0177.0.0.1,
  // and hexadecimal 0x7f.1) to dotted decimal. A public-domain grant must preserve its input as
  // the canonical hostname; otherwise a numeric loopback/private target could masquerade as DNS.
  if (!isCanonicalUrlHostname(value)) return false;
  if (IP_LITERAL_PATTERN.test(value)) return false;
  return !RESERVED_DOMAIN_NAMES.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isContentFreeReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
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

// ─── Shared target (parent authority refs) ─────────────────────────────────────────
// Every auxiliary request is bound to exactly one parent run at one observed revision. The child's
// authority is always DERIVED from this parent; an auxiliary request can never carry its own
// envelope, grant, or widened scope.
export interface AuxiliaryCapabilityTarget {
  readonly taskId: CodeTaskTaskId;
  readonly runId: CodeTaskRunId;
  readonly workspaceId: CodeTaskWorkspaceId;
  readonly stateRevision: number;
  readonly idempotencyKey: CodeTaskIdempotencyKey;
}

const AUXILIARY_TARGET_KEYS = ["taskId", "runId", "workspaceId", "stateRevision", "idempotencyKey"];

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

// ─── Research grant scope (public research only) ───────────────────────────────────
// A research grant names the public domains it permits and its exact expiry. An empty `domains`
// list means "any public host" is NOT allowed — an explicit empty list fails closed; a research
// grant must always name at least one domain. The queryTextDigest is the sha256 of the sanitized
// visible query — the only repository-derived outbound research text — so evidence stays content
// free while still binding the request to what the user saw.
export interface AuxiliaryResearchScopeV1 {
  readonly grantId: CodeTaskGrantId;
  readonly domains: readonly string[];
  readonly expiresAt: string;
  readonly queryTextDigest: CodeTaskFact<string>;
}

const RESEARCH_SCOPE_KEYS = ["grantId", "domains", "expiresAt", "queryTextDigest"];

function isCodeTaskIsoInstantLike(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.endsWith("Z");
}

function factErrors(
  value: unknown,
  path: string,
  isKnownValue: (candidate: unknown) => boolean,
): string[] {
  if (!isRecord(value)) return [`${path} must be a tagged fact object`];
  if (value.outcome === "known") {
    return isKnownValue(value.value) ? [] : [`${path}.value is invalid`];
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

function researchScopeErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["research scope must be an object"];
  const errors = unknownKeys(value, RESEARCH_SCOPE_KEYS, "researchScope");
  if (!isCodeTaskGrantId(value.grantId)) errors.push("researchScope.grantId is invalid");
  if (
    !Array.isArray(value.domains) ||
    value.domains.length === 0 ||
    !value.domains.every((domain) => isCodeTaskPublicDomain(domain))
  ) {
    errors.push("researchScope.domains must be a non-empty list of public domains");
  }
  if (!isCodeTaskIsoInstantLike(value.expiresAt)) {
    errors.push("researchScope.expiresAt must be an ISO-8601 UTC instant");
  }
  errors.push(
    ...factErrors(value.queryTextDigest, "researchScope.queryTextDigest", isCodeTaskSha256Digest),
  );
  return errors;
}

// ─── Capability request (discriminated on capability) ──────────────────────────────
export const AUXILIARY_CAPABILITIES = Object.freeze(["research", "skill", "child-agent"] as const);
export type AuxiliaryCapability = (typeof AUXILIARY_CAPABILITIES)[number];

export type AuxiliaryCapabilityRequestV1 = AuxiliaryCapabilityTarget &
  (
    | {
        readonly schemaVersion: typeof CODE_TASK_AUXILIARY_SCHEMA_VERSION;
        readonly capability: "research";
        readonly research: AuxiliaryResearchScopeV1;
      }
    | {
        readonly schemaVersion: typeof CODE_TASK_AUXILIARY_SCHEMA_VERSION;
        readonly capability: "skill";
        readonly skillId: CodeTaskSkillId;
        // Whether the runtime chose the skill implicitly (catalog policy) or the operator/agent
        // typed `$skill`; both produce the same visible, audited event but the fact is retained.
        readonly invocation: "explicit" | "implicit";
      }
    | {
        readonly schemaVersion: typeof CODE_TASK_AUXILIARY_SCHEMA_VERSION;
        readonly capability: "child-agent";
        readonly childRunId: CodeTaskChildRunId;
        // The maximum tool calls the child may make; charged against the parent budget. A child can
        // never exceed the parent's remaining budget regardless of this value.
        readonly maxToolCalls: number;
      }
  );

const RESEARCH_REQUEST_KEYS = [...AUXILIARY_TARGET_KEYS, "schemaVersion", "capability", "research"];
const SKILL_REQUEST_KEYS = [
  ...AUXILIARY_TARGET_KEYS,
  "schemaVersion",
  "capability",
  "skillId",
  "invocation",
];
const CHILD_REQUEST_KEYS = [
  ...AUXILIARY_TARGET_KEYS,
  "schemaVersion",
  "capability",
  "childRunId",
  "maxToolCalls",
];

export const AUXILIARY_INVOCATIONS = Object.freeze(["explicit", "implicit"] as const);

function requestKeysFor(capability: unknown): readonly string[] | undefined {
  if (capability === "research") return RESEARCH_REQUEST_KEYS;
  if (capability === "skill") return SKILL_REQUEST_KEYS;
  if (capability === "child-agent") return CHILD_REQUEST_KEYS;
  return undefined;
}

function requestVariantErrors(value: Record<string, unknown>): string[] {
  if (value.capability === "research") return researchScopeErrors(value.research);
  if (value.capability === "skill") {
    const errors: string[] = [];
    if (!isCodeTaskSkillId(value.skillId)) errors.push("skillId is invalid");
    if (!isOneOf(value.invocation, AUXILIARY_INVOCATIONS)) errors.push("invocation is invalid");
    return errors;
  }
  const errors: string[] = [];
  if (!isCodeTaskChildRunId(value.childRunId)) errors.push("childRunId is invalid");
  if (!isPositiveInteger(value.maxToolCalls)) {
    errors.push("maxToolCalls must be a positive integer");
  }
  return errors;
}

export function validateAuxiliaryCapabilityRequestV1(
  value: unknown,
): CodingWorkbenchValidationResult<AuxiliaryCapabilityRequestV1> {
  if (!isRecord(value)) return { ok: false, errors: ["auxiliary request must be an object"] };
  const keys = requestKeysFor(value.capability);
  if (keys === undefined) {
    return { ok: false, errors: ["capability must be research, skill, or child-agent"] };
  }
  const errors = unknownKeys(value, keys, "auxiliaryRequest");
  if (value.schemaVersion !== CODE_TASK_AUXILIARY_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  errors.push(...targetErrors(value), ...requestVariantErrors(value));
  return errors.length === 0
    ? { ok: true, value: value as unknown as AuxiliaryCapabilityRequestV1 }
    : { ok: false, errors };
}

// ─── Capability outcome (discriminated on status) ──────────────────────────────────
// A normalized, content-free outcome. `accepted` carries a progress/result ref plus, for a child
// agent, its explicit result count (zero is valid and explicit). Every non-accepted status carries
// a bounded reason code only. `limit-reached` and `stopped` are distinct from `denied` so a child
// scheduler and the UI can tell an exhausted budget or a cascaded stop from a policy denial. The
// status vocabulary is the single canonical `CodingWorkbenchAuxiliaryStatus` from the base module
// (also carried on the runtime event's `auxiliaryOutcome` field), so the port and the timeline
// never drift.
export const AUXILIARY_OUTCOME_STATUSES = CODING_WORKBENCH_AUXILIARY_STATUSES;
export type AuxiliaryOutcomeStatus = CodingWorkbenchAuxiliaryStatus;

export type AuxiliaryCapabilityOutcomeV1 =
  | {
      readonly schemaVersion: typeof CODE_TASK_AUXILIARY_SCHEMA_VERSION;
      readonly status: "accepted";
      readonly capability: AuxiliaryCapability;
      readonly resultDigest: CodeTaskFact<string>;
      // Only ever present for a child-agent outcome; explicit zero is a valid, non-error result.
      readonly childResultCount: CodeTaskFact<number>;
    }
  | {
      readonly schemaVersion: typeof CODE_TASK_AUXILIARY_SCHEMA_VERSION;
      readonly status: "denied" | "unavailable" | "limit-reached" | "stopped";
      readonly capability: AuxiliaryCapability;
      readonly reasonCode: string;
    };

const ACCEPTED_OUTCOME_KEYS = [
  "schemaVersion",
  "status",
  "capability",
  "resultDigest",
  "childResultCount",
];
const REJECTED_OUTCOME_KEYS = ["schemaVersion", "status", "capability", "reasonCode"];

function isChildResultCountFact(value: unknown): boolean {
  return factErrors(value, "childResultCount", isNonNegativeInteger).length === 0;
}

function acceptedOutcomeErrors(value: Record<string, unknown>): string[] {
  const errors = factErrors(
    value.resultDigest,
    "auxiliaryOutcome.resultDigest",
    isCodeTaskSha256Digest,
  );
  if (!isChildResultCountFact(value.childResultCount)) {
    errors.push("auxiliaryOutcome.childResultCount must be a tagged non-negative-integer fact");
  }
  return errors;
}

function outcomeVariantErrors(value: Record<string, unknown>): string[] {
  if (value.status === "accepted") return acceptedOutcomeErrors(value);
  if (!isOneOf(value.status, AUXILIARY_OUTCOME_STATUSES)) return [];
  return isContentFreeReasonCode(value.reasonCode)
    ? []
    : ["auxiliaryOutcome.reasonCode must be a bounded content-free reason code"];
}

export function validateAuxiliaryCapabilityOutcomeV1(
  value: unknown,
): CodingWorkbenchValidationResult<AuxiliaryCapabilityOutcomeV1> {
  if (!isRecord(value)) return { ok: false, errors: ["auxiliary outcome must be an object"] };
  const errors = unknownKeys(
    value,
    value.status === "accepted" ? ACCEPTED_OUTCOME_KEYS : REJECTED_OUTCOME_KEYS,
    "auxiliaryOutcome",
  );
  if (value.schemaVersion !== CODE_TASK_AUXILIARY_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isOneOf(value.status, AUXILIARY_OUTCOME_STATUSES)) errors.push("status is invalid");
  if (!isOneOf(value.capability, AUXILIARY_CAPABILITIES)) errors.push("capability is invalid");
  errors.push(...outcomeVariantErrors(value));
  return errors.length === 0
    ? { ok: true, value: value as unknown as AuxiliaryCapabilityOutcomeV1 }
    : { ok: false, errors };
}

/**
 * The port interface. Not JSON-serializable itself; its request and outcome are the contracts. A
 * single request yields a single normalized outcome; child lifecycle progress surfaces separately
 * as content-free runtime events on the parent transcript.
 */
export interface AuxiliaryCapabilityPortV1 {
  readonly request: (
    request: AuxiliaryCapabilityRequestV1,
  ) => Promise<AuxiliaryCapabilityOutcomeV1>;
}
