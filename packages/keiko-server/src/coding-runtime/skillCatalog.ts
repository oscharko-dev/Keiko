// Server-owned, in-memory, content-free catalog of the approved skills a Code task may invoke
// (Issue #2387, Module B). A skill is server-approved authority, never user-authored or
// runtime-minted: an entry names an exact `id@version` (validated by `isCodeTaskSkillId`), whether
// implicit (catalog-policy) invocation is permitted, and one closed, canonical capability field.
// Skill metadata is an authority-smuggling channel, so every candidate entry is canonicalized and
// closed on registration — invalid or free-form input fails closed (the skill is simply not
// admitted) and the produced entry carries only the bounded canonical fields, nothing else.
import { isCodeTaskSkillId, type CodeTaskSkillId } from "@oscharko-dev/keiko-contracts";

// The closed, canonical purpose vocabulary for an approved skill. Every approved skill is read-only;
// the category names *which* read-only surface it draws on. There is deliberately no free-form
// metadata field: a bounded enum cannot compose into a secret, URL, path, or command fragment.
export const SKILL_CATEGORIES = Object.freeze([
  "repository-analysis",
  "public-research",
  "documentation-lookup",
] as const);

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** A canonical, closed catalog entry. Only these fields exist — registration strips everything else. */
export interface SkillCatalogEntry {
  readonly skillId: CodeTaskSkillId;
  readonly implicitAllowed: boolean;
  readonly category: SkillCategory;
}

/** The loose registration input; each candidate is runtime-validated and closed before admission. */
export interface SkillCatalogEntryInput {
  readonly skillId: string;
  readonly implicitAllowed: boolean;
  readonly category: SkillCategory;
}

/**
 * The read-only catalog surface. Every lookup is an exact `id@version` match; an unknown or
 * unapproved id fails closed (`undefined` / `false`), never a prefix or version-range match.
 */
export interface SkillCatalog {
  readonly has: (skillId: string) => boolean;
  readonly get: (skillId: string) => SkillCatalogEntry | undefined;
  readonly list: () => readonly SkillCatalogEntry[];
  readonly isImplicitAllowed: (skillId: string) => boolean;
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
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === "string" && (SKILL_CATEGORIES as readonly string[]).includes(value);
}

// Canonicalize and close one candidate entry. Any field that does not validate fails the whole
// entry closed (returns `undefined`); a valid entry is rebuilt as a frozen object carrying only the
// three canonical fields, so smuggled free-form keys can never survive registration.
function canonicalizeEntry(entry: unknown): SkillCatalogEntry | undefined {
  if (!isRecord(entry)) return undefined;
  const { skillId, implicitAllowed, category } = entry;
  if (!isCodeTaskSkillId(skillId)) return undefined;
  if (typeof implicitAllowed !== "boolean") return undefined;
  if (!isSkillCategory(category)) return undefined;
  return Object.freeze({ skillId, implicitAllowed, category });
}

/**
 * Build a server-approved skill catalog. Entries default to the read-only seed; a caller may inject
 * a fully-canonicalized set instead. Invalid entries are dropped (fail closed) and the first
 * admission of a given `id@version` wins, so a later untrusted duplicate can never override it.
 */
export function createServerApprovedSkillCatalog(
  entries: readonly SkillCatalogEntryInput[] = DEFAULT_APPROVED_SKILLS,
): SkillCatalog {
  const approved = new Map<string, SkillCatalogEntry>();
  for (const candidate of entries) {
    const entry = canonicalizeEntry(candidate);
    if (entry !== undefined && !approved.has(entry.skillId)) {
      approved.set(entry.skillId, entry);
    }
  }
  const snapshot = Object.freeze([...approved.values()]);
  return {
    has: (skillId: string): boolean => approved.has(skillId),
    get: (skillId: string): SkillCatalogEntry | undefined => approved.get(skillId),
    list: (): readonly SkillCatalogEntry[] => snapshot,
    isImplicitAllowed: (skillId: string): boolean =>
      approved.get(skillId)?.implicitAllowed === true,
  };
}
