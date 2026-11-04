// Shared loading of the lab's JSON sets (#4207, #4208): a directory of `*.json` files, each parsed
// and validated fail-closed, sorted by id, with duplicate ids refused. Scenarios and blueprints are
// two such sets with one loader and one shape of error, each under its own error name.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** An error of one file or entry of a set, `<id>: <message>`, under the set's own error name. */
export class SetFileError extends Error {
  constructor(name, id, message) {
    super(`${id}: ${message}`);
    this.name = name;
  }
}

function parseJsonFile(path, fail) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(path, `not valid JSON (${error.message})`);
  }
}

/**
 * Loads every `*.json` file of a directory through `validate`, sorted by id, refusing duplicate ids;
 * `fail(id, message)` throws the set's own error and `what` names an entry in that message.
 */
export function loadJsonSet(directory, { validate, fail, what }) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  const entries = files.map((name) => validate(parseJsonFile(join(directory, name), fail)));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) fail(entry.id, `duplicate ${what} id in the set`);
    ids.add(entry.id);
  }
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}
