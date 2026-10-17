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
import {
  hasInheritedEnumerableProperty,
  isCodeTaskIsoInstant,
  isCodeTaskSha256Digest,
  ownField,
} from "./code-task-acceptance.js";
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
  isContentFreeReasonCode,
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
const RESERVED_DOMAIN_NAMES = Object.freeze([
  "localhost",
  "localhost.localdomain",
  "local",
  "internal",
  "home.arpa",
  "test",
  "invalid",
  "example",
]);

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

function isReservedDomainName(value: string): boolean {
  return RESERVED_DOMAIN_NAMES.some(
    (reserved) => value === reserved || value.endsWith(`.${reserved}`),
  );
}

export function isCodeTaskPublicDomain(value: unknown): value is string {
  if (typeof value !== "string" || !PUBLIC_DOMAIN_PATTERN.test(value)) return false;
  // WHATWG canonicalizes every legacy IPv4 spelling (for example 127.1, octal 0177.0.0.1,
  // and hexadecimal 0x7f.1) to dotted decimal. A public-domain grant must preserve its input as
  // the canonical hostname; otherwise a numeric loopback/private target could masquerade as DNS.
  if (!isCanonicalUrlHostname(value)) return false;
  if (IP_LITERAL_PATTERN.test(value)) return false;
  const finalLabel = value.split(".").at(-1);
  // A purely numeric final label can be a legacy IPv4 spelling. Requiring at least one letter
  // rejects that resolver ambiguity without excluding valid Punycode or alphanumeric DNS labels.
  if (finalLabel === undefined || !/[a-z]/u.test(finalLabel)) return false;
  return !isReservedDomainName(value);
}

// KfQ Critical on code-task-acceptance.ts's identical unknownKeys (this file mirrors it, and was
// missed by that audit round): a value shaped via Object.create(secretHolder) can carry every
// required field as an OWN property (so it looks complete) plus one extra field reachable ONLY
// through the prototype -- no own-property-only scan (Object.keys, Object.getOwnPropertyNames, or
// an exact-own-count check) ever sees it, while ordinary property access on it still resolves
// through the prototype chain. Rejecting any non-default prototype closes this at the single choke
// point every validator in this file already passes through.
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
}

// Object.getOwnPropertyNames (not Object.keys) plus an own-symbol check, matching the sibling
// files' idiom: Object.keys alone misses a non-enumerable own property. isRecord above rejects a
// non-default prototype; neither closes a genuinely polluted Object.prototype (see
// hasInheritedEnumerableProperty's own comment at its definition in code-task-acceptance.ts).
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

function targetFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;

  if (!isCodeTaskTaskId(ownField(value, "taskId")))
    valid = addValidationError(errors, "taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId")))
    valid = addValidationError(errors, "runId is invalid");
  if (!isCodeTaskWorkspaceId(ownField(value, "workspaceId")))
    valid = addValidationError(errors, "workspaceId is invalid");
  if (!isNonNegativeInteger(ownField(value, "stateRevision"))) {
    valid = addValidationError(errors, "stateRevision must be a non-negative integer");
  }
  if (!isCodeTaskIdempotencyKey(ownField(value, "idempotencyKey"))) {
    valid = addValidationError(errors, "idempotencyKey is invalid");
  }
  return valid;
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
  return isCodeTaskIsoInstant(value);
}

// KEIKO-0302 follow-on: this validated `outcome`/`value` but never rejected an extra key riding
// alongside a well-formed value, so a valid known fact (or an absent/unknown/unavailable fact with
// no "value" key) padded with free text validated and was returned verbatim. This contract family
// is documented as content-free (see the module header). The two pinned messages —
// `${path}.value is invalid` and `${path} must not carry a value for outcome ${outcome}` — are
// preserved exactly for their original cases; every other extra key is now rejected too, via the
// shared unknownKeys helper.
// Round 3 (#2899): this file's isRecord had no prototype-identity check at all until this same
// change, so it was reachable by the basic Object.create({value: "secret"}) attack from the very
// first round of this audit series -- not just by a genuinely polluted global Object.prototype like
// the sibling files. hasInheritedEnumerableProperty (imported, not reimplemented: see its own
// definition and comment in code-task-acceptance.ts, which this module already imports value
// exports from) is a strict superset of the old "value" in value check and closes the same
// polluted-outcome/polluted-undeclared-field gap Codex found there. Reused rather than duplicated:
// code-task-run-control.ts keeps its own separate copy for now (pre-existing, tested, out of scope
// for this change), but a fresh third copy in a third file would be the "another per-property
// special case" this audit explicitly stopped doing. Both branches below now collect instead of
// early-returning, matching the fix already applied to every sibling validator (KfQ 3789542365's
// shape existed here too, in both branches).
function knownFactFieldsAreValid(
  errors: string[],
  value: Record<string, unknown>,
  path: string,
  isKnownValue: (candidate: unknown) => boolean,
): boolean {
  let valid = true;
  valid = appendValidationErrors(errors, unknownKeys(value, ["outcome", "value"], path)) && valid;
  if (!isKnownValue(ownField(value, "value")))
    valid = addValidationError(errors, `${path}.value is invalid`);
  return valid;
}

function factFieldsAreValid(
  errors: string[],
  value: unknown,
  path: string,
  isKnownValue: (candidate: unknown) => boolean,
): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, `${path} must be a tagged fact object`);
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      `${path} must not resolve any field through its prototype chain`,
    );
  }
  const outcome = ownField(value, "outcome");
  if (outcome === "known") return knownFactFieldsAreValid(errors, value, path, isKnownValue);
  if (outcome === "unknown" || outcome === "unavailable" || outcome === "absent") {
    valid = appendValidationErrors(errors, unknownKeys(value, ["outcome"], path)) && valid;
    if (Object.hasOwn(value, "value")) {
      valid = addValidationError(errors, `${path} must not carry a value for outcome ${outcome}`);
    }
    return valid;
  }
  return addValidationError(
    errors,
    `${path}.outcome must be known, unknown, unavailable, or absent`,
  );
}

function researchScopeFieldsAreValid(errors: string[], value: unknown): boolean {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "research scope must be an object");
  valid =
    appendValidationErrors(errors, unknownKeys(value, RESEARCH_SCOPE_KEYS, "researchScope")) &&
    valid;
  if (!isCodeTaskGrantId(ownField(value, "grantId")))
    valid = addValidationError(errors, "researchScope.grantId is invalid");
  const domains = ownField(value, "domains");
  if (!isDomainArray(domains)) {
    valid = addValidationError(
      errors,
      "researchScope.domains must be a non-empty list of public domains",
    );
  }
  if (!isCodeTaskIsoInstantLike(ownField(value, "expiresAt"))) {
    valid = addValidationError(errors, "researchScope.expiresAt must be an ISO-8601 UTC instant");
  }
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "queryTextDigest"),
      "researchScope.queryTextDigest",
      isCodeTaskSha256Digest,
    ) && valid;
  return valid;
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

function requestVariantFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  const capability = ownField(value, "capability");
  if (!isOneOf(capability, AUXILIARY_CAPABILITIES))
    return addValidationError(errors, "capability must be research, skill, or child-agent");
  if (capability === "research")
    return researchScopeFieldsAreValid(errors, ownField(value, "research"));
  if (capability === "skill") {
    if (!isCodeTaskSkillId(ownField(value, "skillId")))
      valid = addValidationError(errors, "skillId is invalid");
    if (!isOneOf(ownField(value, "invocation"), AUXILIARY_INVOCATIONS)) {
      valid = addValidationError(errors, "invocation is invalid");
    }
    return valid;
  }

  if (!isCodeTaskChildRunId(ownField(value, "childRunId")))
    valid = addValidationError(errors, "childRunId is invalid");
  if (!isPositiveInteger(ownField(value, "maxToolCalls"))) {
    valid = addValidationError(errors, "maxToolCalls must be a positive integer");
  }
  return valid;
}

function admitAuxiliaryCapabilityRequestV1(
  value: unknown,
  errors: string[],
): value is AuxiliaryCapabilityRequestV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "auxiliary request must be an object");
  const keys = requestKeysFor(ownField(value, "capability"));
  if (keys === undefined) {
    return addValidationError(errors, "capability must be research, skill, or child-agent");
  }
  valid = appendValidationErrors(errors, unknownKeys(value, keys, "auxiliaryRequest")) && valid;
  if (ownField(value, "schemaVersion") !== CODE_TASK_AUXILIARY_SCHEMA_VERSION) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  valid = [
    valid,
    targetFieldsAreValid(errors, value),
    requestVariantFieldsAreValid(errors, value),
  ].every(Boolean);
  return valid;
}

export function validateAuxiliaryCapabilityRequestV1(
  value: unknown,
): CodingWorkbenchValidationResult<AuxiliaryCapabilityRequestV1> {
  const errors: string[] = [];
  return admitAuxiliaryCapabilityRequestV1(value, errors)
    ? { ok: true, value }
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
  const errors: string[] = [];
  return factFieldsAreValid(errors, value, "childResultCount", isNonNegativeInteger);
}

function acceptedOutcomeFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  let valid = true;
  valid =
    factFieldsAreValid(
      errors,
      ownField(value, "resultDigest"),
      "auxiliaryOutcome.resultDigest",
      isCodeTaskSha256Digest,
    ) && valid;
  if (!isChildResultCountFact(ownField(value, "childResultCount"))) {
    valid = addValidationError(
      errors,
      "auxiliaryOutcome.childResultCount must be a tagged non-negative-integer fact",
    );
  }
  // KEIKO-0626 (sub-fix on the auxiliary side): only a child-agent outcome may report a `known`
  // childResultCount — a research or skill call has no children, so a known count on those
  // capabilities is a producer defect that must not silently reach downstream consumers.
  const capability = ownField(value, "capability");
  if (!isOneOf(capability, AUXILIARY_CAPABILITIES)) {
    valid = false;
    if (!errors.includes("capability is invalid")) errors.push("capability is invalid");
  }
  const childResultCount = ownField(value, "childResultCount");
  const childCountOutcome = isRecord(childResultCount)
    ? ownField(childResultCount, "outcome")
    : undefined;
  if (childCountOutcome === "known" && capability !== "child-agent") {
    valid = addValidationError(
      errors,
      `auxiliaryOutcome.childResultCount.outcome=known is only valid when capability is child-agent, got ${String(capability)}`,
    );
  }
  return valid;
}

function outcomeVariantFieldsAreValid(errors: string[], value: Record<string, unknown>): boolean {
  const status = ownField(value, "status");
  if (status === "accepted") return acceptedOutcomeFieldsAreValid(errors, value);
  if (!isOneOf(status, AUXILIARY_OUTCOME_STATUSES)) {
    if (!errors.includes("status is invalid")) errors.push("status is invalid");
    return false;
  }
  return (
    isContentFreeReasonCode(ownField(value, "reasonCode")) ||
    addValidationError(
      errors,
      "auxiliaryOutcome.reasonCode must be a bounded content-free reason code",
    )
  );
}

function admitAuxiliaryCapabilityOutcomeV1(
  value: unknown,
  errors: string[],
): value is AuxiliaryCapabilityOutcomeV1 {
  let valid = true;
  if (!isRecord(value)) return addValidationError(errors, "auxiliary outcome must be an object");
  const status = ownField(value, "status");
  valid =
    appendValidationErrors(
      errors,
      unknownKeys(
        value,
        status === "accepted" ? ACCEPTED_OUTCOME_KEYS : REJECTED_OUTCOME_KEYS,
        "auxiliaryOutcome",
      ),
    ) && valid;
  if (ownField(value, "schemaVersion") !== CODE_TASK_AUXILIARY_SCHEMA_VERSION) {
    valid = addValidationError(errors, "schemaVersion must be the literal 1");
  }
  if (!isOneOf(status, AUXILIARY_OUTCOME_STATUSES))
    valid = addValidationError(errors, "status is invalid");
  if (!isOneOf(ownField(value, "capability"), AUXILIARY_CAPABILITIES)) {
    valid = addValidationError(errors, "capability is invalid");
  }
  valid = outcomeVariantFieldsAreValid(errors, value) && valid;
  return valid;
}

export function validateAuxiliaryCapabilityOutcomeV1(
  value: unknown,
): CodingWorkbenchValidationResult<AuxiliaryCapabilityOutcomeV1> {
  const errors: string[] = [];
  return admitAuxiliaryCapabilityOutcomeV1(value, errors)
    ? { ok: true, value }
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

function isDomainArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const entries: readonly unknown[] = value;
  const length = entries.length;
  for (let index = 0; index < length; index += 1) {
    if (!isCodeTaskPublicDomain(entries[index])) return false;
  }
  return true;
}
