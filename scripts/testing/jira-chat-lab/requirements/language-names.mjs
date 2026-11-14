// The names a session's Jira shows its actors (#4369): what `seed-language.mjs` recorded next to the
// administrator's English names, joined by id. The Composer lane takes the localized issue type name
// (what a German project lead writes into a template and a German person says) and the type id from
// here, never from a word list of its own. A session without the table has no localized data.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const isRow = (row) =>
  row !== null &&
  typeof row === "object" &&
  [row.id, row.english, row.localized].every((value) => typeof value === "string" && value !== "");

/** The recorded language data of a session, or undefined without a usable issue type table. */
export function languageData(session) {
  if (typeof session?.directory !== "string") return undefined;
  const path = join(session.directory, "language.json");
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data.issueTypes) || !data.issueTypes.every(isRow)) return undefined;
  return {
    locale: String(data.locale),
    issueTypes: data.issueTypes,
    statuses: Array.isArray(data.statuses) ? data.statuses.filter(isRow) : [],
  };
}

/** How a template or a request names an issue type: by the name its audience sees, or by id. */
export const TYPE_LABELS = Object.freeze(["name", "id"]);

/**
 * The label of an English type name for a session: the localized name (identity for an English or
 * unrecorded session) or the numeric id. A type the table does not hold is a lab error, never a guess.
 */
export function typeLabel(data, english, kind = "name") {
  if (!TYPE_LABELS.includes(kind)) throw new TypeError(`Unknown type label ${String(kind)}`);
  if (data === undefined) {
    if (kind === "id") throw new TypeError("This session has no recorded issue type ids");
    return english;
  }
  const row = data.issueTypes.find((entry) => entry.english === english);
  if (row === undefined)
    throw new TypeError(`The session's language data holds no type ${english}`);
  return kind === "id" ? row.id : row.localized;
}

/** Whether the session's actors see another name for at least one type than the administrator. */
export const isLocalized = (data) =>
  data !== undefined && data.issueTypes.some((row) => row.localized !== row.english);
