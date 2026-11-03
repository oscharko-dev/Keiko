// Coverage of a corpus by scenario class and language (#4208). The epic requires at least 30 scenarios
// per class and language per corpus version, so that a class result has a noise band at all. The
// manifest of a build carries the counts behind that rule, and a focused build also names every
// required class and language that fell short, so a shortage is a line in the manifest and not a
// surprise in a report.
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
  "way-of-working",
  "decision",
  "update",
  "reversal",
  "edit-after-learn",
  "entrenchment",
  "forget",
  "forget-paraphrase",
  "credential",
  "identifier",
  "third-party",
  "hypothetical",
  "question",
  "instruction-smuggling",
]);

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

/** The required class and language pairs below the minimum, with the count they reached. */
export function shortfalls(counts, minimum = MINIMUM_PER_CLASS_AND_LANGUAGE) {
  const reached = new Map(counts.map((row) => [`${row.class}/${row.language}`, row.scenarios]));
  return REQUIRED_CLASSES.flatMap((className) =>
    BLUEPRINT_LANGUAGES.map((language) => ({
      class: className,
      language,
      scenarios: reached.get(`${className}/${language}`) ?? 0,
    })),
  ).filter((row) => row.scenarios < minimum);
}

/** The coverage section of a focused build's manifest. */
export function coverageSection(counts) {
  return {
    minimumPerClassAndLanguage: MINIMUM_PER_CLASS_AND_LANGUAGE,
    requiredClasses: REQUIRED_CLASSES,
    shortfalls: shortfalls(counts),
  };
}
