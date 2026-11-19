// The one classification of who wrote a forget tombstone (#4223).
//
// A tombstone exists so that a fact the PERSON asked to forget is never silently relearned. Only
// surfaces classified here as UNATTENDED are exempt from that refusal: they record that Keiko
// removed a record under a storage policy, never that a person refused the fact. The direction is
// fail-closed: a surface that is not listed (a new or mistyped writer) still refuses, so a
// forgotten fact can never come back through an unclassified writer.

/** The person forgot a fact in the Memory window. */
export const MEMORY_CENTER_FORGETTER_SURFACE = "memory-center";
/** The person forgot a fact with a clear statement in a Chat. */
export const MEMORY_CHAT_STATEMENT_FORGETTER_SURFACE = "chat-statement";
/** The unattended maintenance pass removed a record. */
export const MEMORY_MAINTENANCE_FORGETTER_SURFACE = "memory-maintenance";
/** Operator retention policy (age or overflow) removed a record. */
export const MEMORY_RETENTION_FORGETTER_SURFACE = "retention";

export const MEMORY_PERSON_FORGETTER_SURFACES: readonly string[] = [
  MEMORY_CENTER_FORGETTER_SURFACE,
  MEMORY_CHAT_STATEMENT_FORGETTER_SURFACE,
];

export const MEMORY_UNATTENDED_FORGETTER_SURFACES: readonly string[] = [
  MEMORY_MAINTENANCE_FORGETTER_SURFACE,
  MEMORY_RETENTION_FORGETTER_SURFACE,
];

export function isPersonForgetterSurface(surface: string | undefined): boolean {
  return surface !== undefined && MEMORY_PERSON_FORGETTER_SURFACES.includes(surface);
}

export function isUnattendedForgetterSurface(surface: string | undefined): boolean {
  return surface !== undefined && MEMORY_UNATTENDED_FORGETTER_SURFACES.includes(surface);
}

// SQL predicate (no bind parameters) that keeps only tombstones allowed to refuse a statement. It is
// shared by exact and semantic suppression. A tombstone refuses unless its surface is explicitly
// unattended AND it records that the removed record was not rejected (`original_status`, written by
// deleteMemory(ies) for every writer since vault schema v4). So an unattended tombstone refuses in
// two cases: it removed a record the person REJECTED, because removal by retention or maintenance
// must never let a rejected fact be captured again; and its `original_status` is NULL (a row
// written before the column existed), because the rejection can no longer be ruled out. Refusing
// such a legacy row also refuses the restatement of a fact whose old unattended tombstone carries
// no status; that is the accepted cost of failing closed, and it cannot affect a tombstone written
// since schema v4. The surface comparison fails closed for a NULL surface; the column is `NOT NULL`
// in the schema, so that is unreachable today. The values are fixed constants, never user input.
export const REFUSING_TOMBSTONE_SQL = `(COALESCE(forgetter_surface, '') NOT IN (${MEMORY_UNATTENDED_FORGETTER_SURFACES.map(
  (surface) => `'${surface}'`,
).join(", ")}) OR original_status IS NULL OR original_status = 'rejected')`;
