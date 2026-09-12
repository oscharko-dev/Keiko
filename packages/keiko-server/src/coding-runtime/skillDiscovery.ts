// Approved-skill readiness and discovery (Issue #3417, ADR-0137, ADR-0175). One readiness decision
// serves discovery and invocation alike: an approved skill can run now only when it is enabled,
// compatible with the run's bound catalog profile, its category's handler is mounted, the live
// authority allows the workspace read it performs, and the budget still holds its one delegated
// read. Discovery projects the closed, body-free record the contract defines and nothing else: the
// model sees only the skills it may invoke now, the operator every approved skill with its
// readiness.
import type {
  SkillCategory,
  SkillDiscoveryEntryV1,
  SkillDiscoveryResultV1,
  SkillReadinessV1,
  SkillUnavailableReason,
} from "@oscharko-dev/keiko-contracts";
import {
  SKILL_DISCOVERY_SCHEMA_VERSION,
  skillVersionOf,
} from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import type { SkillCatalog, SkillCatalogEntry } from "./skillCatalog.js";

/** The catalog profile a run is bound to. */
export interface SkillProfileRef {
  readonly id: string;
  readonly version: number;
}

/** What a run can tell about a skill before any authority or budget question is asked. */
export interface SkillStaticFacts {
  readonly profile: SkillProfileRef;
  readonly handlerMounted: (category: SkillCategory) => boolean;
}

/** The facts of one readiness decision; the live questions are asked anew on every decision. */
export interface SkillReadinessFacts extends SkillStaticFacts {
  readonly authorityAllowsRead: () => boolean;
  readonly delegatedReadFits: () => boolean;
}

const READY: SkillReadinessV1 = Object.freeze({ state: "ready" });

function unavailable(reason: SkillUnavailableReason): SkillReadinessV1 {
  return { state: "unavailable", reason };
}

function compatible(entry: SkillCatalogEntry, profile: SkillProfileRef): boolean {
  return (
    entry.compatibility.profile === profile.id &&
    entry.compatibility.minVersion <= profile.version &&
    profile.version <= entry.compatibility.maxVersion
  );
}

/** Enabled, compatible and handled: what makes a skill worth advertising to a run at all. */
export function staticSkillReadiness(
  entry: SkillCatalogEntry,
  facts: SkillStaticFacts,
): SkillReadinessV1 {
  if (!entry.enabled) return unavailable("disabled");
  if (!compatible(entry, facts.profile)) return unavailable("incompatible");
  if (!facts.handlerMounted(entry.category)) return unavailable("handler-unavailable");
  return READY;
}

/** Whether an approved skill can run now: the one decision discovery and invocation share. */
export function skillReadiness(
  entry: SkillCatalogEntry,
  facts: SkillReadinessFacts,
): SkillReadinessV1 {
  const statically = staticSkillReadiness(entry, facts);
  if (statically.state === "unavailable") return statically;
  if (!facts.authorityAllowsRead()) return unavailable("authority-denied");
  if (!facts.delegatedReadFits()) return unavailable("budget-exhausted");
  return READY;
}

function discoveryEntry(
  entry: SkillCatalogEntry,
  readiness: SkillReadinessV1,
): SkillDiscoveryEntryV1 {
  return {
    skillId: entry.skillId,
    version: skillVersionOf(entry.skillId),
    sourceDigest: entry.sourceDigest,
    category: entry.category,
    capabilities: entry.capabilities,
    compatibility: entry.compatibility,
    readiness,
  };
}

// Asks the live questions once for a whole projection, so every skill in it is judged against the
// same moment's authority and budget.
function settledFacts(facts: SkillReadinessFacts): SkillReadinessFacts {
  const authority = facts.authorityAllowsRead();
  const budget = facts.delegatedReadFits();
  return { ...facts, authorityAllowsRead: () => authority, delegatedReadFits: () => budget };
}

/** Every approved skill with its readiness: the operator's view of the catalog. */
export function approvedSkillProjection(
  catalog: Pick<SkillCatalog, "list" | "digest">,
  facts: SkillReadinessFacts,
): SkillDiscoveryResultV1 {
  const settled = settledFacts(facts);
  return {
    schemaVersion: SKILL_DISCOVERY_SCHEMA_VERSION,
    catalogDigest: catalog.digest(),
    skills: catalog.list().map((entry) => discoveryEntry(entry, skillReadiness(entry, settled))),
  };
}

/**
 * The operator's view of the catalog: every approved skill with the readiness a run can tell before
 * any live question. Authority and budget are facts of one call, not of the catalog, so this
 * projection never asks them and can never spend one (#3417).
 */
export function operatorSkillProjection(
  catalog: Pick<SkillCatalog, "list" | "digest">,
  facts: SkillStaticFacts,
): SkillDiscoveryResultV1 {
  return {
    schemaVersion: SKILL_DISCOVERY_SCHEMA_VERSION,
    catalogDigest: catalog.digest(),
    skills: catalog
      .list()
      .map((entry) => discoveryEntry(entry, staticSkillReadiness(entry, facts))),
  };
}

/** The model's view of a projection: only the skills that are ready and that it may invoke now. */
export function invocableSkillDiscovery(
  projection: SkillDiscoveryResultV1,
  invocable: (skillId: string) => boolean,
): SkillDiscoveryResultV1 {
  return {
    ...projection,
    skills: projection.skills.filter(
      (skill) => skill.readiness.state === "ready" && invocable(skill.skillId),
    ),
  };
}

/** A projection's unavailable skills counted per closed reason, for body-free evidence. */
export function unavailableSkillCounts(
  projection: SkillDiscoveryResultV1,
): Readonly<Partial<Record<SkillUnavailableReason, number>>> {
  const counts: Partial<Record<SkillUnavailableReason, number>> = {};
  for (const skill of projection.skills) {
    if (skill.readiness.state === "unavailable") {
      counts[skill.readiness.reason] = (counts[skill.readiness.reason] ?? 0) + 1;
    }
  }
  return counts;
}
