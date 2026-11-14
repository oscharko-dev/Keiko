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
    title: "Every issue type is created conformant by a plain instruction, also several at once",
    obligations: [
      ...slugs.map((slug) => `create-conformant-${slug}`),
      "multi-create-all-created",
      "multi-create-keys-listed",
      "multi-create-answer-keys",
      "unrepairable-refused-natively",
      "unrepairable-refused-by-gate",
      "unrepairable-answer-plain",
    ],
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
    title:
      "No template for the type: nothing is created, the product's own refusal and hint are stored, in every mode",
    obligations: slugs.flatMap((slug) =>
      COMPOSER_MODES.flatMap((mode) => [
        `no-template-refused-${slug}-${mode.key}`,
        `no-template-hint-${slug}-${mode.key}`,
        `no-template-answer-${slug}-${mode.key}`,
      ]),
    ),
  },
  {
    id: "C04",
    requirement: "composer",
    issue: 4354,
    title:
      "Edits: a breaking edit is refused; a pre-existing violation, a missing template and a status change do not block",
    obligations: [
      "edit-breaking-refused-clear-field",
      "edit-breaking-refused-parent",
      "edit-preexisting-notice",
      "edit-preexisting-answer",
      "edit-no-template-passes",
      "status-change-no-template-passes",
    ],
  },
  {
    id: "C05",
    requirement: "composer",
    issue: 4354,
    title:
      "The same order sent again in one conversation, after its stored messages were read again and straight away, creates no duplicate",
    obligations: [
      "stored-conversation-matches-turn",
      "repeat-after-reread-no-duplicate",
      "repeat-after-reread-reply-refers",
      "repeat-in-chat-no-duplicate",
      "repeat-in-chat-reply-refers",
    ],
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
  {
    id: "C08",
    requirement: "composer",
    issue: 4354,
    title: "A watcher and a comment by plain instruction, verified natively",
    obligations: ["watcher-added", "comment-written", "watcher-removed"],
  },
  {
    id: "C09",
    requirement: "composer",
    issue: 4354,
    title: "An attachment request is refused readably and nothing reaches Jira",
    obligations: ["attachment-refused", "attachment-answer-readable"],
  },
]);
