/**
 * The automation rows Keiko admits in a native run's private database (#4546, ADR-0137 D10).
 *
 * OpenCode 2.3.1 replaced its schedules with automations: a row of the `automation` table runs a
 * prompt, a Code Mode program or a shell command at a time, on an interval, on a cron, or when an
 * MCP server pushes an event. Keiko's scheduled wakes (C09) use exactly one shape of it: a prompt
 * into the creating session on a time, an interval or a cron. Everything else runs outside a human
 * run with the runtime server's environment, so the policy refuses it at creation, and a row that
 * carries it anyway is state Keiko did not admit: the retention audit refuses the copy and the
 * wake run never releases the scheduler lease over it.
 */

/** The id the runtime gives an automation (`aut_` and an ascending identifier). */
export const AUTOMATION_ID_PATTERN = /^aut_[0-9A-Za-z]{1,64}$/u;

/**
 * The id OpenCode 2.2.5 gave a schedule. A consent ledger retained under that version still names
 * them; Keiko reads such an id only to show its schedule as removed, never to change or wake it.
 */
export const RETIRED_SCHEDULE_ID_PATTERN = /^sch_[0-9A-Za-z]{1,64}$/u;

/** The only triggers a scheduled wake uses; an `event` trigger is a watch on an MCP server. */
export const ADMITTED_AUTOMATION_TRIGGERS: readonly string[] = Object.freeze([
  "at",
  "every",
  "cron",
]);

/** The largest action (its prompt) and name a retained copy may carry, in characters. */
export const RETAINED_SCHEDULE_ACTION_MAX_CHARS = 16_384;
export const RETAINED_SCHEDULE_NAME_MAX_CHARS = 256;
/** The longest delivery summary the runtime writes for a prompt (`Prompted ses_…`), with room. */
export const RETAINED_SCHEDULE_OUTPUT_MAX_CHARS = 1_024;
/** At most this many automations are carried in a ledger; more refuse the retain. */
export const RETAINED_SCHEDULE_MAX = 64;

/** A JSON field of a column, or NULL when the column is not valid JSON (never an error). */
function jsonField(column: string, path: string): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;
}

/**
 * Whether a row is not a scheduled wake of the session: of another session or of none, a status the
 * producer does not write, an id Keiko cannot name, an oversized action, name or output, code state
 * or an event cursor, a trigger other than a time, an interval or a cron, or an action other than a
 * prompt into the session itself. Two positional parameters: the session id, twice.
 */
export const UNADMITTED_AUTOMATION_PREDICATE = [
  "session_id IS NOT ?",
  "status NOT IN ('active', 'paused', 'done')",
  "state IS NOT NULL",
  "event_position IS NOT NULL",
  "id NOT GLOB 'aut_?*'",
  "substr(id, 5) GLOB '*[^0-9A-Za-z]*'",
  "length(id) > 68",
  `length(action) > ${String(RETAINED_SCHEDULE_ACTION_MAX_CHARS)}`,
  `length(COALESCE(name, '')) > ${String(RETAINED_SCHEDULE_NAME_MAX_CHARS)}`,
  `length(COALESCE(last_output, '')) > ${String(RETAINED_SCHEDULE_OUTPUT_MAX_CHARS)}`,
  `COALESCE(${jsonField("trigger", "$.type")}, '') NOT IN (${ADMITTED_AUTOMATION_TRIGGERS.map((type) => `'${type}'`).join(", ")})`,
  `COALESCE(${jsonField("action", "$.type")}, '') <> 'prompt'`,
  `${jsonField("action", "$.to.session")} IS NOT ?`,
].join(" OR ");
