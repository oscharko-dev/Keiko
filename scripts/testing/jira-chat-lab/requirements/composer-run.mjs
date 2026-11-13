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

/** The types and modes the run selected, validated against the closed vocabularies. */
export function composerSelectionOf({ types, modes }) {
  const typeSlugs = new Set(COMPOSER_TYPES.map(typeSlug));
  const modeKeys = new Set(COMPOSER_MODES.map((entry) => entry.key));
  const wantedTypes = csv(types);
  const wantedModes = csv(modes);
  for (const [label, wanted, known] of [
    ["--types", wantedTypes, typeSlugs],
    ["--modes", wantedModes, modeKeys],
  ])
    for (const item of wanted ?? [])
      if (!known.has(item))
        throw new TypeError(`${label} names ${item}; known: ${[...known].join(", ")}`);
  return {
    ...(wantedTypes ? { types: wantedTypes } : {}),
    ...(wantedModes ? { modes: wantedModes } : {}),
  };
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
