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

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
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
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function compatibilityErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = unknownKeys(value, COMPATIBILITY_KEYS, path);
  const profile = ownField(value, "profile");
  if (typeof profile !== "string" || !PROFILE_ID_PATTERN.test(profile)) {
    errors.push(`${path}.profile is invalid`);
  }
  const minVersion = ownField(value, "minVersion");
  const maxVersion = ownField(value, "maxVersion");
  if (!isProfileVersion(minVersion)) errors.push(`${path}.minVersion is invalid`);
  if (!isProfileVersion(maxVersion)) errors.push(`${path}.maxVersion is invalid`);
  if (isProfileVersion(minVersion) && isProfileVersion(maxVersion) && minVersion > maxVersion) {
    errors.push(`${path}.minVersion must not exceed maxVersion`);
  }
  return errors;
}

function capabilitiesErrors(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array`];
  if (value.length > SKILL_DISCOVERY_LIMITS.maxCapabilities) {
    return [`${path} must hold at most ${String(SKILL_DISCOVERY_LIMITS.maxCapabilities)} ids`];
  }
  const errors: string[] = value.flatMap((id: unknown, index) =>
    isCapabilityId(id) ? [] : [`${path}[${String(index)}] is invalid`],
  );
  if (errors.length === 0 && !strictlyAscending(value as readonly string[])) {
    errors.push(`${path} must be sorted and unique`);
  }
  return errors;
}

/** A compatibility range with a valid profile id and 1 <= minVersion <= maxVersion. */
export function isSkillCompatibilityV1(value: unknown): value is SkillCompatibilityV1 {
  return compatibilityErrors(value, "compatibility").length === 0;
}

/** A sorted, unique, bounded set of ids in the catalog's canonical tool identity shape. */
export function isSkillCapabilitySet(value: unknown): value is readonly string[] {
  return capabilitiesErrors(value, "capabilities").length === 0;
}

function readinessErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const state = ownField(value, "state");
  if (state === "ready") return unknownKeys(value, ["state"], path);
  if (state !== "unavailable") return [`${path}.state must be ready or unavailable`];
  const errors = unknownKeys(value, ["state", "reason"], path);
  if (!isOneOf(ownField(value, "reason"), SKILL_UNAVAILABLE_REASONS)) {
    errors.push(`${path}.reason is invalid`);
  }
  return errors;
}

function entryErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors = unknownKeys(value, ENTRY_KEYS, path);
  const skillId = ownField(value, "skillId");
  if (!isCodeTaskSkillId(skillId)) {
    errors.push(`${path}.skillId is invalid`);
  } else if (ownField(value, "version") !== skillVersionOf(skillId)) {
    errors.push(`${path}.version must be the version of skillId`);
  }
  if (!isCodeTaskSha256Digest(ownField(value, "sourceDigest"))) {
    errors.push(`${path}.sourceDigest is invalid`);
  }
  if (!isSkillCategory(ownField(value, "category"))) errors.push(`${path}.category is invalid`);
  errors.push(
    ...capabilitiesErrors(ownField(value, "capabilities"), `${path}.capabilities`),
    ...compatibilityErrors(ownField(value, "compatibility"), `${path}.compatibility`),
    ...readinessErrors(ownField(value, "readiness"), `${path}.readiness`),
  );
  return errors;
}

function skillsErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["skills must be an array"];
  if (value.length > SKILL_DISCOVERY_LIMITS.maxSkills) {
    return [`skills must hold at most ${String(SKILL_DISCOVERY_LIMITS.maxSkills)} entries`];
  }
  const errors: string[] = value.flatMap((entry: unknown, index) =>
    entryErrors(entry, `skills[${String(index)}]`),
  );
  if (errors.length > 0) return errors;
  // One version per skill: two ids of one skill (`@1` beside `@1.0`, or an older version beside a
  // newer one) would let a downgraded or confusable binding hide behind the listing.
  const names = (value as readonly SkillDiscoveryEntryV1[]).map((entry) =>
    skillNameOf(entry.skillId),
  );
  return new Set(names).size === names.length ? [] : ["skills must name each skill once"];
}

/** Validates a discovery result exactly and closed: no key, value or skill outside the contract. */
export function validateSkillDiscoveryResultV1(
  value: unknown,
): CodingWorkbenchValidationResult<SkillDiscoveryResultV1> {
  if (!isRecord(value)) return { ok: false, errors: ["skill discovery result must be an object"] };
  const errors = unknownKeys(value, RESULT_KEYS, "skillDiscovery");
  if (ownField(value, "schemaVersion") !== SKILL_DISCOVERY_SCHEMA_VERSION) {
    errors.push("schemaVersion must be the literal 1");
  }
  if (!isCodeTaskSha256Digest(ownField(value, "catalogDigest"))) {
    errors.push("catalogDigest is invalid");
  }
  errors.push(...skillsErrors(ownField(value, "skills")));
  return errors.length === 0
    ? { ok: true, value: value as unknown as SkillDiscoveryResultV1 }
    : { ok: false, errors };
}
