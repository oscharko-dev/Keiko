// Reads the Activity Log of a dev checkout for the body-free run summaries. Segment files are
// enumerated and ordered only through the closed grammar in keiko-contracts (activity-log-files.ts);
// this module never restates it. Lines that are not JSON are skipped, never repaired.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importBuilt } from "./lab-common.mjs";

/** --log-dir, KEIKO_LAB_LOG_DIR, or <KEIKO_STATE_DIR or ./.keiko/dev>/logs (the dev server's default). */
export function resolveLogDirectory(explicit, env = process.env) {
  if (explicit !== undefined) return resolve(explicit);
  if (env.KEIKO_LAB_LOG_DIR) return resolve(env.KEIKO_LAB_LOG_DIR);
  return join(resolve(env.KEIKO_STATE_DIR ?? join(process.cwd(), ".keiko", "dev")), "logs");
}

function parseLine(line) {
  try {
    const event = JSON.parse(line);
    return event !== null && typeof event === "object" ? event : undefined;
  } catch {
    return undefined;
  }
}

/** Logical text for lab views; normalizes unterminated inter-file delimiters, not a byte-exact artifact. */
export async function readActivityLogText(logDirectory) {
  const grammar = await importBuilt("keiko-contracts", "activity-log-files.js");
  const files = grammar.readableActivityLogFileNames(
    grammar.orderActivityLogFileNames(readdirSync(logDirectory)),
  );
  const texts = files.map((file) => readFileSync(join(logDirectory, file.name), "utf8"));
  return texts
    .map((text, index) => (index < texts.length - 1 && !text.endsWith("\n") ? `${text}\n` : text))
    .join("");
}

/** Every event of the logical log in file order. */
export async function readActivityEvents(logDirectory) {
  const text = await readActivityLogText(logDirectory);
  return text
    .split("\n")
    .map(parseLine)
    .filter((event) => event !== undefined);
}

/** The run's own events plus those of the child requests it spawned, oldest first. */
export function selectRunEvents(events, suffix) {
  const children = new Set(
    events
      .filter((event) => (event.parentCorrelationId ?? "").endsWith(suffix))
      .map((event) => event.correlationId),
  );
  const mine = events.filter(
    (event) => (event.correlationId ?? "").endsWith(suffix) || children.has(event.correlationId),
  );
  return mine.toSorted((left, right) => (left.ts ?? "").localeCompare(right.ts ?? ""));
}

/** The event with its `extra` fields lifted to the top level. */
export function flatten(event) {
  return { ...event, ...event.extra };
}
