// The command-line side of the Composer lane (#4369): which scenarios, types and modes a run takes,
// which journeys need a product started without the lab's baseline template set, and where the
// report goes. Pure, so the usage errors and the grouping are testable without a scorecard run.
import { COMPOSER_MODES, COMPOSER_WITHOUT_BASELINE } from "./composer.mjs";
import { COMPOSER_TYPES, typeSlug } from "./composer-templates.mjs";

const csv = (value) =>
  value === undefined ? undefined : value.split(",").filter((item) => item !== "");

/** Refuses an id that is not in the selected set: an empty "valid" report must never result. */
export function selectedScenarios(catalog, only, setName) {
  const wanted = csv(only);
  if (wanted === undefined) return catalog;
  const known = new Set(catalog.map((scenario) => scenario.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0 || wanted.length === 0)
    throw new TypeError(
      `--only names ${unknown.join(", ") || "nothing"}, which is not in the ${setName} set (${[...known].join(", ")})`,
    );
  return catalog.filter((scenario) => wanted.includes(scenario.id));
}

/** The reports C07 runs: S10 (progress) and S11 (compliance); `--parts s10` runs one of them. */
export const REPORT_PARTS = Object.freeze(["s10", "s11"]);

/** The types and modes the run selected, validated against the closed vocabularies. */
export function composerSelectionOf({ types, modes, parts }) {
  const selection = {
    types: csv(types),
    modes: csv(modes),
    parts: csv(parts),
  };
  const vocabularies = {
    types: ["--types", new Set(COMPOSER_TYPES.map(typeSlug))],
    modes: ["--modes", new Set(COMPOSER_MODES.map((entry) => entry.key))],
    parts: ["--parts", new Set(REPORT_PARTS)],
  };
  for (const [key, [label, known]] of Object.entries(vocabularies))
    for (const item of selection[key] ?? [])
      if (!known.has(item))
        throw new TypeError(`${label} names ${item}; known: ${[...known].join(", ")}`);
  return Object.fromEntries(Object.entries(selection).filter(([, wanted]) => wanted !== undefined));
}

/**
 * The journeys that need the baseline set off (C03 and C04 prove a missing template) run in their own
 * product start; every other journey keeps the default. Order is kept inside each group.
 */
export function composerGroups(ids) {
  const without = ids.filter((id) => COMPOSER_WITHOUT_BASELINE.includes(id));
  const rest = ids.filter((id) => !COMPOSER_WITHOUT_BASELINE.includes(id));
  return [
    ...(rest.length > 0 ? [{ ids: rest, baseline: "default" }] : []),
    ...(without.length > 0 ? [{ ids: without, baseline: "off" }] : []),
  ];
}

/**
 * What a group of Composer journeys reads from the session's `requirements-truth.json`. Only C07
 * runs the document lane's S10 and S11 oracles, which compare against the whole record; every other
 * journey needs the work project and the two custom field ids it creates parents with. The rest of
 * the record (the expected issues, deviations and uncovered requirements of the document lane)
 * never reaches a journey that does not grade them.
 */
export function composerTruth(truth, ids) {
  if (ids.includes("C07")) return truth;
  return {
    projects: { work: truth.projects.work },
    fieldIds: { epicName: truth.fieldIds.epicName, epicLink: truth.fieldIds.epicLink },
  };
}

/**
 * The Composer graders compare English issue type names, so every journey except the S10 report runs
 * on an English session. A German session (the oracles then read as the localized actor) only takes
 * `C07 --parts s10`, the proof that the report matches its readback in German.
 */
export function assertComposerLanguageFit(reader, ids, selection) {
  if (reader === "admin") return;
  const onlyS10 =
    ids.length === 1 &&
    ids[0] === "C07" &&
    selection.parts?.length === 1 &&
    selection.parts[0] === "s10";
  if (!onlyS10)
    throw new TypeError(
      "This session is German-language: the Composer journeys grade English issue type names. Run them on an English session; a German one takes only --only C07 --parts s10",
    );
}

/** The report directory of a model: its id, made safe, so two models never share a report. */
export function reportDirectoryName(model) {
  const safe = String(model ?? "no-model")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "_")
    .slice(0, 80);
  return safe === "" ? "no-model" : safe;
}

/** Runs `body` with KEIKO_JIRA_LAB_BASELINE_TEMPLATES set for the product it starts, then restores it. */
export async function withBaselineSetting(baseline, body, env = process.env) {
  const previous = env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES;
  if (baseline === "off") env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES = "off";
  try {
    return await body();
  } finally {
    if (previous === undefined) delete env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES;
    else env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES = previous;
  }
}
