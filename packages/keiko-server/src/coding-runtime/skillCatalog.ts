// Server-owned, in-memory, content-free catalog of the approved skills a Code task may invoke
// (Issue #2387, Module B; discovery and atomic change, Issue #3417). A skill is server-approved
// authority, never user-authored or runtime-minted: an entry names an exact `id@version`
// (validated by `isCodeTaskSkillId`), whether implicit (catalog-policy) invocation is permitted,
// one closed category, the catalogued capabilities it draws on, the catalog profile versions it
// works with, and whether it is enabled. Skill metadata is an authority-smuggling channel, so every
// candidate entry is canonicalized and closed on admission — invalid or free-form input fails
// closed (the skill is simply not admitted) and the produced entry carries only the bounded
// canonical fields, nothing else.
//
// The catalog is the one authority for skill state, and it changes only through `replace`, which
// admits a whole next set as one new frozen snapshot with one new revision and digest. Installing,
// removing, updating, disabling and revoking a skill are each such a next set, so every one of
// them invalidates a discovery projection bound to the prior digest.
import type {
  CodeTaskSha256Digest,
  CodeTaskSkillId,
  SkillCategory,
  SkillCompatibilityV1,
} from "@oscharko-dev/keiko-contracts";
import { isCodeTaskSkillId } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import {
  isSkillCapabilitySet,
  isSkillCategory,
  isSkillCompatibilityV1,
  SKILL_DISCOVERY_LIMITS,
  skillNameOf,
} from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { opencodeRegistrationSet } from "@oscharko-dev/keiko-tool-catalog";

const OPENCODE_REGISTRATION = opencodeRegistrationSet();

/** The catalog profile an OpenCode run is bound to; an approved skill must be compatible with it. */
export const OPENCODE_SKILL_PROFILE: Readonly<{ readonly id: string; readonly version: number }> =
  Object.freeze({
    id: OPENCODE_REGISTRATION.profile.id,
    version: OPENCODE_REGISTRATION.profile.version,
  });

// The canonical tool ids the bound catalog actually holds: the only capabilities a skill may name.
const CATALOGUED_TOOL_IDS: ReadonlySet<string> = new Set(
  OPENCODE_REGISTRATION.entries.map((entry) => entry.descriptor.toolRef.canonicalId),
);

/** A canonical, closed catalog entry. Only these fields exist — admission strips everything else. */
export interface SkillCatalogEntry {
  readonly skillId: CodeTaskSkillId;
  readonly implicitAllowed: boolean;
  readonly category: SkillCategory;
  readonly capabilities: readonly string[];
  readonly compatibility: SkillCompatibilityV1;
  readonly enabled: boolean;
  /** SHA-256 of the canonical definition: every field but `enabled`, which is state. */
  readonly sourceDigest: CodeTaskSha256Digest;
}

/** The loose admission input; each candidate is runtime-validated and closed before admission. */
export interface SkillCatalogEntryInput {
  readonly skillId: string;
  readonly implicitAllowed: boolean;
  readonly category: SkillCategory;
  readonly capabilities: readonly string[];
  readonly compatibility: SkillCompatibilityV1;
  /** Omitted means enabled. */
  readonly enabled?: boolean;
}

/** What one admitted change did, body-free, for the caller's activity evidence. */
export interface SkillCatalogChange {
  readonly revision: number;
  readonly admitted: number;
  readonly dropped: number;
}

/**
 * The catalog surface. Every lookup is an exact `id@version` match; an unknown or unapproved id
 * fails closed (`undefined` / `false`), never a prefix or version-range match.
 */
export interface SkillCatalog {
  readonly has: (skillId: string) => boolean;
  readonly get: (skillId: string) => SkillCatalogEntry | undefined;
  readonly list: () => readonly SkillCatalogEntry[];
  readonly isImplicitAllowed: (skillId: string) => boolean;
  /** Starts at 1 and grows by one with every change. */
  readonly revision: () => number;
  /** SHA-256 over the revision and the canonical entries; every change changes it. */
  readonly digest: () => CodeTaskSha256Digest;
  /** Admits a whole next set as one atomic change; a failing candidate is dropped, fail closed. */
  readonly replace: (entries: readonly SkillCatalogEntryInput[]) => SkillCatalogChange;
}

// The default seed of read-only skills. It flows through the same canonicalization path as any
// injected entry, so there is exactly one admission gate for the catalog.
//
// The seed lists ONLY categories the production skill port can actually execute — today just
// `repository-analysis` (productionAuxiliaryPorts.executeApprovedSkill). Advertising a skill whose
// category has no handler is worse than not advertising it: the model reads the catalog, invokes
// it, and burns a turn on a `skill-handler-unavailable` outcome it cannot learn from. The
// `public-research` and `documentation-lookup` categories stay defined in SKILL_CATEGORIES and are
// re-seeded here by whichever child implements their handler.
const DEFAULT_APPROVED_SKILLS: readonly SkillCatalogEntryInput[] = Object.freeze([
  {
    skillId: "skl_repo-structure-summary@1",
    implicitAllowed: true,
    category: "repository-analysis",
    capabilities: ["keiko.workspace.read"],
    compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
  },
]);

type SkillDefinition = Omit<SkillCatalogEntry, "enabled" | "sourceDigest">;

interface CatalogSnapshot {
  readonly revision: number;
  readonly byId: ReadonlyMap<string, SkillCatalogEntry>;
  readonly entries: readonly SkillCatalogEntry[];
  readonly digest: CodeTaskSha256Digest;
  readonly dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// Canonicalize and close one candidate's definition. Any field that does not validate fails the
// whole entry closed (`undefined`); a capability the bound catalog does not hold is refused like a
// malformed one, so a skill can never name a tool the catalog lacks.
function definitionOf(entry: Record<string, unknown>): SkillDefinition | undefined {
  const skillId = own(entry, "skillId");
  const implicitAllowed = own(entry, "implicitAllowed");
  const category = own(entry, "category");
  const capabilities = own(entry, "capabilities");
  const compatibility = own(entry, "compatibility");
  if (!isCodeTaskSkillId(skillId) || typeof implicitAllowed !== "boolean") return undefined;
  if (!isSkillCategory(category) || !isSkillCompatibilityV1(compatibility)) return undefined;
  if (!isSkillCapabilitySet(capabilities)) return undefined;
  if (!capabilities.every((id) => CATALOGUED_TOOL_IDS.has(id))) return undefined;
  return {
    skillId,
    implicitAllowed,
    category,
    capabilities: Object.freeze([...capabilities]),
    compatibility: Object.freeze({
      profile: compatibility.profile,
      minVersion: compatibility.minVersion,
      maxVersion: compatibility.maxVersion,
    }),
  };
}

function canonicalizeEntry(candidate: unknown): SkillCatalogEntry | undefined {
  if (!isRecord(candidate)) return undefined;
  const enabled = own(candidate, "enabled") ?? true;
  if (typeof enabled !== "boolean") return undefined;
  const definition = definitionOf(candidate);
  if (definition === undefined) return undefined;
  return Object.freeze({
    ...definition,
    enabled,
    sourceDigest: sha256Hex(canonicalise(definition)) as CodeTaskSha256Digest,
  });
}

// Admits a whole set at once. Invalid candidates are dropped, and the first admission of a skill
// wins: a later candidate naming the same skill — the same id, or another version or spelling of
// it — is dropped, so an untrusted duplicate can never override or shadow an approved skill, and a
// downgrade can never sit beside the version it replaced. Beyond the discovery limit every further
// candidate is dropped.
function admit(candidates: readonly unknown[], revision: number): CatalogSnapshot {
  const byId = new Map<string, SkillCatalogEntry>();
  const names = new Set<string>();
  for (const candidate of candidates) {
    const entry = canonicalizeEntry(candidate);
    if (entry === undefined || names.has(skillNameOf(entry.skillId))) continue;
    if (byId.size >= SKILL_DISCOVERY_LIMITS.maxSkills) continue;
    names.add(skillNameOf(entry.skillId));
    byId.set(entry.skillId, entry);
  }
  const entries = Object.freeze([...byId.values()]);
  return {
    revision,
    byId,
    entries,
    digest: sha256Hex(canonicalise({ revision, entries })) as CodeTaskSha256Digest,
    dropped: candidates.length - entries.length,
  };
}

/**
 * Build a server-approved skill catalog. Entries default to the read-only seed; a caller may inject
 * a set instead. Invalid entries are dropped (fail closed) and the first admission of a skill wins,
 * so a later untrusted duplicate can never override it.
 */
export function createServerApprovedSkillCatalog(
  entries: readonly SkillCatalogEntryInput[] = DEFAULT_APPROVED_SKILLS,
): SkillCatalog {
  let current = admit(entries, 1);
  return {
    has: (skillId: string): boolean => current.byId.has(skillId),
    get: (skillId: string): SkillCatalogEntry | undefined => current.byId.get(skillId),
    list: (): readonly SkillCatalogEntry[] => current.entries,
    isImplicitAllowed: (skillId: string): boolean =>
      current.byId.get(skillId)?.implicitAllowed === true,
    revision: (): number => current.revision,
    digest: (): CodeTaskSha256Digest => current.digest,
    replace: (next: readonly SkillCatalogEntryInput[]): SkillCatalogChange => {
      current = admit(next, current.revision + 1);
      return {
        revision: current.revision,
        admitted: current.entries.length,
        dropped: current.dropped,
      };
    },
  };
}
