// Coverage of a corpus by scenario class and language (#4208). The epic requires at least 30 scenarios
// per class and language per corpus version, so that a class result has a noise band at all. The
// minimum counts distinct units (independent facts, changes, forgets and traps): one unit stated four
// ways under three seeds is twelve scenarios, but one thing measured twelve times, and a class that
// rests on six things has no breadth whatever its scenario count says. The manifest of a build
// carries both counts, and a focused build names every required class and language whose units fall
// short, so a shortage is a line in the manifest and not a surprise in a report.
import { compareStrings } from "../../../lib/compare-strings.mjs";
import { BLUEPRINT_LANGUAGES } from "./blueprint.mjs";

export const MINIMUM_PER_CLASS_AND_LANGUAGE = 30;

/**
 * The scenario classes that must reach the minimum in every language: the epic's list, with the
 * correction of an earlier message and the entrenchment loop, which #4208 names among the classes
 * the first corpus version must carry.
 */
export const REQUIRED_CLASSES = Object.freeze([
  "preference",
  "role",
  "way-of-working",
  "decision",
  "project-decision",
  "update",
  "reversal",
  "edit-after-learn",
  "entrenchment",
  "forget",
  "forget-paraphrase",
  "forget-not",
  "credential",
  "identifier",
  "third-party",
  "operator-in-third-party",
  "hypothetical",
  "irony",
  "contradiction",
  "quote",
  "question",
  "assistant-claim",
  "instruction-smuggling",
  "memory-injection",
]);
// A poisoned memory is seeded, not said, so a conversation around it has no language of its own to mix.
const UNMIXED_CLASSES = new Set(["memory-injection"]);
const COVERED_LANGUAGES = Object.freeze([...BLUEPRINT_LANGUAGES, "mixed"]);
// "A fact spread across two turns" is a way of stating a fact, so it is a difficulty and not a class;
// the report has its row, and the minimum holds for it all the same.
const SPLIT_DIFFICULTY = "split";

/**
 * Scenarios and distinct units (blueprint units) per class and language, sorted by class and then
 * language. `entries` need a `class`, a `language` and a `unit`; the units show how many independent
 * things sit behind a count, since one fact stated four ways and under three seeds is twelve scenarios.
 */
export function classCounts(entries) {
  const table = new Map();
  for (const entry of entries) {
    const key = `${entry.class}\u0000${entry.language}`;
    const row = table.get(key) ?? {
      class: entry.class,
      language: entry.language,
      scenarios: 0,
      units: new Set(),
    };
    row.scenarios += 1;
    row.units.add(entry.unit);
    table.set(key, row);
  }
  return [...table.values()]
    .map((row) => ({ ...row, units: row.units.size }))
    .toSorted(
      (left, right) =>
        compareStrings(left.class, right.class) || compareStrings(left.language, right.language),
    );
}

/** The required class and language pairs whose distinct units fall below the minimum, with both counts. */
export function shortfalls(counts, minimum = MINIMUM_PER_CLASS_AND_LANGUAGE) {
  const reached = new Map(counts.map((row) => [`${row.class}/${row.language}`, row]));
  return REQUIRED_CLASSES.flatMap((className) =>
    COVERED_LANGUAGES.filter(
      (language) => language !== "mixed" || !UNMIXED_CLASSES.has(className),
    ).map((language) => {
      const row = reached.get(`${className}/${language}`);
      return { class: className, language, scenarios: row?.scenarios ?? 0, units: row?.units ?? 0 };
    }),
  ).filter((row) => row.units < minimum);
}

/** The distinct units told over two turns, per blueprint language, with the same minimum. */
function splitCoverage(entries) {
  const told = entries.filter((entry) => entry.difficulty === SPLIT_DIFFICULTY);
  return BLUEPRINT_LANGUAGES.map((language) => {
    const units = new Set(
      told.filter((entry) => entry.language === language).map((entry) => entry.unit),
    );
    return { language, units: units.size, reached: units.size >= MINIMUM_PER_CLASS_AND_LANGUAGE };
  });
}

/** The coverage section of a focused build's manifest. */
export function coverageSection(counts, entries = []) {
  return {
    minimumPerClassAndLanguage: MINIMUM_PER_CLASS_AND_LANGUAGE,
    minimumCounts: "units",
    requiredClasses: REQUIRED_CLASSES,
    shortfalls: shortfalls(counts),
    splitStatements: splitCoverage(entries),
  };
}
