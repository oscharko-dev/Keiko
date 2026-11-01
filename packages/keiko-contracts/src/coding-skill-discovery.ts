// Approved-skill discovery projection (Issue #3417, ADR-0175, ADR-0137). The canonical tool catalog
// owns only the discovery descriptor (`keiko.skill.discover`); the server-approved skill catalog
// stays authoritative for skill state and the governed skill handler for effects. What crosses to
// the model and the operator is this closed, body-free record per approved skill: its pinned id
// and version, a digest of its canonical definition, one closed category, a bounded set of
// catalogued capability ids, the catalog profile range it works with, and a closed readiness state.
// There is deliberately no free-form field. Skill metadata is an authority-smuggling channel, so
// nothing here can carry a summary, prompt, path, endpoint, credential or user content.
import {
  isCodeTaskSha256Digest,
  ownField,
  type CodeTaskSha256Digest,
} from "./code-task-acceptance.js";
import { isCodeTaskSkillId, type CodeTaskSkillId } from "./code-task-auxiliary.js";
import { isOneOf } from "./contract-validation-primitives.js";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";

export const SKILL_DISCOVERY_SCHEMA_VERSION = 1;

/**
 * The closed purpose vocabulary of an approved skill. Every approved skill is read-only; the
 * category names which read-only surface it draws on. A bounded enum cannot compose into a secret,
 * URL, path, or command fragment.
 */
export const SKILL_CATEGORIES = Object.freeze([
  "repository-analysis",
  "public-research",
  "documentation-lookup",
] as const);
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Why an approved skill cannot be invoked now. */
export const SKILL_UNAVAILABLE_REASONS = Object.freeze([
  "disabled",
  "incompatible",
  "handler-unavailable",
  "authority-denied",
  "budget-exhausted",
] as const);
export type SkillUnavailableReason = (typeof SKILL_UNAVAILABLE_REASONS)[number];

export const SKILL_DISCOVERY_LIMITS = Object.freeze({
  /** The most approved skills one catalog holds, and so the most one discovery lists. */
  maxSkills: 32,
  /** The most catalogued capability ids one skill declares. */
  maxCapabilities: 8,
  /** The highest catalog profile version a compatibility range may name. */
  maxProfileVersion: 1_000,
});

export type SkillReadinessV1 =
  | { readonly state: "ready" }
  | { readonly state: "unavailable"; readonly reason: SkillUnavailableReason };

/** The catalog profile versions a skill works with, both bounds inclusive. */
export interface SkillCompatibilityV1 {
  readonly profile: string;
  readonly minVersion: number;
  readonly maxVersion: number;
}

/** One approved skill as discovery reports it; nothing else about a skill crosses this boundary. */
export interface SkillDiscoveryEntryV1 {
  /** The pinned `id@version` keiko_skill takes. */
  readonly skillId: CodeTaskSkillId;
  /** The semantic version part of `skillId`. */
  readonly version: string;
  /** SHA-256 of the skill's canonical definition; changing the definition changes it. */
  readonly sourceDigest: CodeTaskSha256Digest;
  readonly category: SkillCategory;
  /** Canonical tool ids of the catalogued capabilities the skill draws on, sorted and unique. */
  readonly capabilities: readonly string[];
  readonly compatibility: SkillCompatibilityV1;
  readonly readiness: SkillReadinessV1;
}

export interface SkillDiscoveryResultV1 {
  readonly schemaVersion: typeof SKILL_DISCOVERY_SCHEMA_VERSION;
  /** SHA-256 over the approved catalog's revision and entries: any catalog change changes it. */
  readonly catalogDigest: CodeTaskSha256Digest;
  readonly skills: readonly SkillDiscoveryEntryV1[];
}

// The catalog's own canonical tool identity and profile identifier shapes
// (keiko-tool-catalog/src/identity.ts). A shape is all a contract can check; the server admits only
// capability ids its compiled catalog actually holds.
const CAPABILITY_ID_PATTERN = /^keiko\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const CAPABILITY_ID_MAX_CHARS = 128;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const RESULT_KEYS = ["schemaVersion", "catalogDigest", "skills"] as const;
const SKILLS_CHANNEL_KEYS = ["session", "skills"] as const;
const ENTRY_KEYS = [
  "skillId",
  "version",
  "sourceDigest",
  "category",
  "capabilities",
  "compatibility",
  "readiness",
] as const;
const COMPATIBILITY_KEYS = ["profile", "minVersion", "maxVersion"] as const;

// Rejecting any non-default prototype closes a value that carries an extra field reachable only
// through its prototype, which no own-property scan can see (code-task-auxiliary.ts, KfQ Critical).
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

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

/** The semantic version part of a pinned skill id. */
export function skillVersionOf(skillId: CodeTaskSkillId): string {
  return skillId.slice(skillId.indexOf("@") + 1);
}

/** A skill's identity across its versions: the part of its pinned id before `@`. */
export function skillNameOf(skillId: CodeTaskSkillId): string {
  return skillId.slice(0, skillId.indexOf("@"));
}

export function isSkillCategory(value: unknown): value is SkillCategory {
  return isOneOf(value, SKILL_CATEGORIES);
}

function isCapabilityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CAPABILITY_ID_MAX_CHARS &&
    CAPABILITY_ID_PATTERN.test(value)
  );
}

function isProfileVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= SKILL_DISCOVERY_LIMITS.maxProfileVersion
  );
}

function strictlyAscending(values: readonly string[]): boolean {
  const count = values.length;
  for (let index = 0; index < count; index += 1) {
    const value = values[index];
    if (typeof value !== "string") return false;
    const ascending = index === 0 || (values[index - 1] ?? "") < value;
    if (!ascending) return false;
  }
  return true;
}

function checkCompatibility(
  value: unknown,
  path: string,
  errors: string[],
): value is SkillCompatibilityV1 {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...unknownKeys(value, COMPATIBILITY_KEYS, path));
  const profile = ownField(value, "profile");
  const profileValid = typeof profile === "string" && PROFILE_ID_PATTERN.test(profile);
  if (!profileValid) errors.push(`${path}.profile is invalid`);
  const minVersion = ownField(value, "minVersion");
  const maxVersion = ownField(value, "maxVersion");
  const min = isProfileVersion(minVersion);
  const max = isProfileVersion(maxVersion);
  if (!min) errors.push(`${path}.minVersion is invalid`);
  if (!max) errors.push(`${path}.maxVersion is invalid`);
  if (isProfileVersion(minVersion) && isProfileVersion(maxVersion) && minVersion > maxVersion)
    errors.push(`${path}.minVersion must not exceed maxVersion`);
  return [profileValid, min, max].every(Boolean);
}

function checkCapabilities(
  value: unknown,
  path: string,
  errors: string[],
): value is readonly string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  if (value.length > SKILL_DISCOVERY_LIMITS.maxCapabilities) {
    errors.push(`${path} must hold at most ${String(SKILL_DISCOVERY_LIMITS.maxCapabilities)} ids`);
    return false;
  }
  const admitted = checkCapabilityMembers(value, path, errors);
  if (errors.length === 0 && admitted && !strictlyAscending(value))
    errors.push(`${path} must be sorted and unique`);
  return admitted;
}

function checkCapabilityMembers(
  value: readonly unknown[],
  path: string,
  errors: string[],
): value is readonly string[] {
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    if (!isCapabilityId(value[index])) {
      errors.push(`${path}[${String(index)}] is invalid`);
      admitted = false;
      if (!(index in value)) return false;
    }
  }
  return admitted;
}

/** A compatibility range with a valid profile id and 1 <= minVersion <= maxVersion. */
export function isSkillCompatibilityV1(value: unknown): value is SkillCompatibilityV1 {
  const errors: string[] = [];
  const admitted = checkCompatibility(value, "compatibility", errors);
  return admitted && errors.length === 0;
}

/** A sorted, unique, bounded set of ids in the catalog's canonical tool identity shape. */
export function isSkillCapabilitySet(value: unknown): value is readonly string[] {
  const errors: string[] = [];
  const admitted = checkCapabilities(value, "capabilities", errors);
  return admitted && errors.length === 0;
}

function checkReadiness(value: unknown, path: string, errors: string[]): value is SkillReadinessV1 {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const state = ownField(value, "state");
  if (state === "ready") {
    errors.push(...unknownKeys(value, ["state"], path));
    return true;
  }
  if (state !== "unavailable") {
    errors.push(`${path}.state must be ready or unavailable`);
    return false;
  }
  errors.push(...unknownKeys(value, ["state", "reason"], path));
  const reason = isOneOf(ownField(value, "reason"), SKILL_UNAVAILABLE_REASONS);
  if (!reason) errors.push(`${path}.reason is invalid`);
  return reason;
}

function checkEntry(
  value: unknown,
  path: string,
  errors: string[],
): value is SkillDiscoveryEntryV1 {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...unknownKeys(value, ENTRY_KEYS, path));
  const skillId = ownField(value, "skillId");
  const id = isCodeTaskSkillId(skillId);
  let version = false;
  if (!id) errors.push(`${path}.skillId is invalid`);
  else {
    version = ownField(value, "version") === skillVersionOf(skillId);
    if (!version) errors.push(`${path}.version must be the version of skillId`);
  }
  const digest = isCodeTaskSha256Digest(ownField(value, "sourceDigest"));
  if (!digest) errors.push(`${path}.sourceDigest is invalid`);
  const category = isSkillCategory(ownField(value, "category"));
  if (!category) errors.push(`${path}.category is invalid`);
  // Each nested owner starts with its original independent local error collection.
  const capabilityErrors: string[] = [];
  const compatibilityErrors: string[] = [];
  const readinessErrors: string[] = [];
  const capabilities = checkCapabilities(
    ownField(value, "capabilities"),
    `${path}.capabilities`,
    capabilityErrors,
  );
  const compatibility = checkCompatibility(
    ownField(value, "compatibility"),
    `${path}.compatibility`,
    compatibilityErrors,
  );
  const readiness = checkReadiness(
    ownField(value, "readiness"),
    `${path}.readiness`,
    readinessErrors,
  );
  errors.push(...capabilityErrors, ...compatibilityErrors, ...readinessErrors);
  return [id, version, digest, category, capabilities, compatibility, readiness].every(Boolean);
}

function checkSkills(value: unknown, errors: string[]): value is readonly SkillDiscoveryEntryV1[] {
  if (!Array.isArray(value)) {
    errors.push("skills must be an array");
    return false;
  }
  if (value.length > SKILL_DISCOVERY_LIMITS.maxSkills) {
    errors.push(`skills must hold at most ${String(SKILL_DISCOVERY_LIMITS.maxSkills)} entries`);
    return false;
  }
  const members: string[] = [];
  const entries: readonly unknown[] = value;
  const admitted = checkSkillMembers(entries, members);
  errors.push(...members);
  if (members.length > 0 || !admitted) return false;
  // One version per skill: two ids of one skill (`@1` beside `@1.0`, or an older version beside a
  // newer one) would let a downgraded or confusable binding hide behind the listing.
  // Preserve the separate second observation used for one-version-per-skill admission.
  const names: string[] = [];
  const count = entries.length;
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index];
    if (entry === undefined) throw new TypeError("skill entry is unavailable");
    names.push(skillNameOf(entry.skillId));
  }
  if (new Set(names).size !== names.length) errors.push("skills must name each skill once");
  return true;
}

function checkSkillMembers(
  value: readonly unknown[],
  errors: string[],
): value is readonly SkillDiscoveryEntryV1[] {
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const path = `skills[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${path} must be an object`);
      return false;
    }
    admitted = checkEntry(value[index], path, errors) && admitted;
  }
  return admitted;
}

/** Validates a discovery result exactly and closed: no key, value or skill outside the contract. */
export function validateSkillDiscoveryResultV1(
  value: unknown,
): CodingWorkbenchValidationResult<SkillDiscoveryResultV1> {
  if (!isRecord(value)) return { ok: false, errors: ["skill discovery result must be an object"] };
  const errors = unknownKeys(value, RESULT_KEYS, "skillDiscovery");
  const admitted = checkDiscoveryResult(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkDiscoveryResult(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & SkillDiscoveryResultV1 {
  const version = ownField(value, "schemaVersion") === SKILL_DISCOVERY_SCHEMA_VERSION;
  if (!version) errors.push("schemaVersion must be the literal 1");
  const digest = isCodeTaskSha256Digest(ownField(value, "catalogDigest"));
  if (!digest) errors.push("catalogDigest is invalid");
  const memberErrors: string[] = [];
  const skills = checkSkills(ownField(value, "skills"), memberErrors);
  errors.push(...memberErrors);
  return version && digest && skills;
}

// ─── The operator's channel (#3417) ──────────────────────────────────────────────

/** Session facet of a channel-carried skills payload: the status of the presented cookie only. */
export const CODING_WORKBENCH_RUNTIME_SKILLS_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeSkillsSession =
  (typeof CODING_WORKBENCH_RUNTIME_SKILLS_SESSION_STATES)[number];

/**
 * The approved skills of one run as carried over the AUTHENTICATED app-session channel: the same
 * closed, body-free record discovery reports the model, with the readiness a run can tell before any
 * live question. `session` reflects only whether the caller's own cookie is a valid app session,
 * never the existence of a run or of a skill, so an unpaired browser renders an honest re-pair state
 * and the payload is not an existence oracle (ADR-0141 D6).
 */
export interface CodingWorkbenchRuntimeSkillsChannelPayload {
  readonly session: CodingWorkbenchRuntimeSkillsSession;
  readonly skills?: SkillDiscoveryResultV1 | undefined;
}

/**
 * The single source of the constant content-free projection every unauthenticated caller of the
 * skills route receives (ADR-0141 D6): independent of run existence and of the catalog.
 */
export function unpairedCodingWorkbenchRuntimeSkillsChannelPayload(): CodingWorkbenchRuntimeSkillsChannelPayload {
  return { session: "unpaired" };
}

/**
 * Validate a channel-carried skills payload: exact keys, a valid session facet, a listing that holds
 * the discovery contract, and the invariant that an `unpaired` payload carries no skills.
 */
export function validateCodingWorkbenchRuntimeSkillsChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeSkillsChannelPayload> {
  if (!isRecord(value)) return { ok: false, errors: ["skills channel payload must be an object"] };
  const errors = unknownKeys(value, SKILLS_CHANNEL_KEYS, "skillsChannelPayload");
  const admitted = checkSkillsChannel(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkSkillsChannel(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeSkillsChannelPayload {
  const session = ownField(value, "session");
  const sessionValid = isOneOf(session, CODING_WORKBENCH_RUNTIME_SKILLS_SESSION_STATES);
  if (!sessionValid) errors.push("skillsChannelPayload.session is invalid");
  const skills = ownField(value, "skills");
  if (session === "unpaired" && skills !== undefined)
    errors.push("skillsChannelPayload.skills must be absent when the session is unpaired");
  let listingValid = true;
  if (skills !== undefined) {
    const listing = validateSkillDiscoveryResultV1(skills);
    listingValid = listing.ok;
    if (!listing.ok) errors.push(...listing.errors);
  }
  return sessionValid && listingValid;
}
