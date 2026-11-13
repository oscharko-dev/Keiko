// The Composer lane's scenarios (#4369): the Release 1 core, writing Jira from the Chat composer by
// plain instruction with no Knowledge Pod. Own ids (C01-C07), the same obligation/coverage rules and
// the same scorecard as S01-S20, which stay untouched. Selected as one set with `--set composer`.
// Obligations a) to f) of the owner's brief; c) and d) are red on today's product until #4354 lands.
import { SCENARIOS } from "./catalog.mjs";
import { COMPOSER_MODES } from "./composer.mjs";
import { COMPOSER_TYPES, typeSlug } from "./composer-templates.mjs";

const slugs = COMPOSER_TYPES.map(typeSlug);
const obligationsOf = (id) => SCENARIOS.find((scenario) => scenario.id === id).obligations;

export const COMPOSER_SCENARIOS = Object.freeze([
  {
    id: "C01",
    requirement: "composer",
    issue: 4354,
    title: "Every issue type is created conformant by a plain instruction",
    obligations: slugs.map((slug) => `create-conformant-${slug}`),
  },
  {
    id: "C02",
    requirement: "composer",
    issue: 4354,
    title: "A violating request is refused before any card or effect, in every mode",
    obligations: slugs.flatMap((slug) =>
      COMPOSER_MODES.map((mode) => `refused-${slug}-${mode.key}`),
    ),
  },
  {
    id: "C03",
    requirement: "composer",
    issue: 4354,
    title: "No template for the type: refused, with the hint to create one",
    obligations: slugs.map((slug) => `no-template-refused-${slug}`),
  },
  {
    id: "C04",
    requirement: "composer",
    issue: 4354,
    title: "An edit that breaks conformance is refused",
    obligations: ["edit-clear-required-refused", "edit-parent-refused"],
  },
  {
    id: "C05",
    requirement: "composer",
    issue: 4354,
    title: "No duplicates on re-run of the same create request",
    obligations: ["rerun-creates-no-duplicates"],
  },
  {
    id: "C06",
    requirement: "composer",
    issue: 4354,
    title: "Modes and readable approval",
    obligations: obligationsOf("S18"),
  },
  {
    id: "C07",
    requirement: "composer",
    issue: 4356,
    title: "Progress and compliance reports on a Jira-Pod-only Chat",
    obligations: [...new Set([...obligationsOf("S10"), ...obligationsOf("S11")])],
  },
]);
