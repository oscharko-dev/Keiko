// The Composer lane's journeys and graders (#4369, Release 1): Jira writes made from the Chat
// composer by plain instruction, in a Chat bound only to the Jira Pod. No Knowledge Pod, no
// requirements document and no structure skill: the lead's templates are the only structure, and
// every verdict is read from Jira (`ctx.search`) or from the closed fields of the turn's tool
// exchanges, never from the product's own account. The refusal, repair and approval graders of the
// document lane are reused by parameter, not copied.
import { aggregateParts, countsOf, NO_TURN, result, sequentially } from "./journey-support.mjs";
import { snapshotBefore } from "./journey-support.mjs";
import {
  COMPOSER_TYPES,
  composerConformity,
  composerFields,
  composerTemplates,
  createPrompt,
  requiredSections,
  typeSlug,
  violationPrompt,
} from "./composer-templates.mjs";
import { JOURNEYS } from "./journey-checks.mjs";
import { relatedKeys } from "./hierarchy.mjs";
import { MODE_RUNS, modesAndReadableApproval } from "./modes.mjs";
import { turnIssues } from "./oracles.mjs";
import { toolExchangeOf } from "./tool-exchanges.mjs";
import {
  gradeTemplateRepair,
  listTemplates,
  templateRefusals,
  withTemplate,
  withTemplates,
} from "./templates.mjs";

const PROJECT = "REQ";
const typeQuery = (type) => `project = ${PROJECT} AND issuetype = "${type}"`;
const SYNTHETIC_BODY = (sections) =>
  sections.map((name) => `h3. ${name}\nSynthetischer Inhalt.`).join("\n\n");

/** The three autonomy modes of every Chat, with the closed key an obligation name carries. */
export const COMPOSER_MODES = Object.freeze([
  { mode: "governed-assist", key: "ask", label: "Ask for approval" },
  { mode: "supervised-coding", key: "supervised", label: "Supervised workspace" },
  { mode: "autonomous-delivery", key: "full-access", label: "Full access" },
]);

// ---------- pure graders ----------

/** Whether the stored exchange asked a human first: an approval card exists for the call. */
const askedForApproval = (exchange) => exchange?.approval !== undefined;

/** The relation the request named, as Jira holds it, for one type. */
export function composerRelation(type, { epicLink, epic, task }) {
  return (issue) => {
    const fields = issue.fields ?? {};
    switch (type) {
      case "Epic":
        return true;
      case "Sub-task":
        return fields.parent?.key === task;
      case "Bug":
        return fields[epicLink] === epic && relatedKeys(issue).includes(task);
      default:
        return fields[epicLink] === epic;
    }
  };
}

/** Obligation a) — exactly one new conformant issue of the type, with the named relation. */
export function gradeComposerCreate({ type, issues, conforms, related }) {
  const [issue] = issues.created;
  const single = issues.created.length === 1 && issues.credited.length === 1;
  if (!single || issues.duplicates.length > 0)
    return {
      status: "red",
      detail: `${countsOf(issues, type)}; exactly one new ${type} was expected`,
    };
  const conformant = conforms(issue);
  const relation = related(issue);
  return {
    status: conformant && relation ? "green" : "red",
    detail: `${issue.key}: ${conformant ? "conforms to the template" : "does not conform to the template"}, ${relation ? "named relation held" : "named relation missing"}`,
  };
}

/**
 * Obligation b) — a violating request is refused before any card and any effect, and the corrected
 * request then succeeds. `repair` reuses the document lane's grader with this type's conformity.
 */
export function gradeComposerRefusal({ exchanges, issues, template, conforms }) {
  const repair = gradeTemplateRepair({ exchanges, issues, template, conforms });
  if (!repair.detected)
    return {
      status: "unverified",
      detail: `no template refusal in the turn (${repair.refusals} refusals); the gate was not exercised`,
    };
  const refusals = templateRefusals(exchanges);
  const cards = refusals.filter((refusal) => askedForApproval(exchanges[refusal.index])).length;
  const detail = `${repair.refusals} refusals (${repair.ruleIds.join(", ")}), ${cards} with an approval card, ${repair.receipts} with a receipt, ${repair.issues} issues of the turn of which ${repair.nonconforming.length} violate the template`;
  if (cards > 0)
    return { status: "red", detail: `${detail}; a card was shown for a refused write` };
  return { status: repair.repaired ? "green" : "red", detail };
}

const HINT_NOUN = /vorlage|template/iu;
const HINT_VERB = /anleg|\blege\b|\blegen\b|erstell|definier|hinterleg|einricht|create|define/iu;

/** Obligation c) — no template for the type: nothing is written and the answer says to create one. */
export function gradeNoTemplate({ issues, answer }) {
  const created = issues.created.length;
  if (created > 0)
    return {
      status: "red",
      detail: `${created} issues were written although no template governs the type`,
    };
  const hint = HINT_NOUN.test(answer ?? "") && HINT_VERB.test(answer ?? "");
  return hint
    ? { status: "green", detail: "refused, and the answer tells the person to create a template" }
    : {
        status: "red",
        detail: "nothing was written, but the answer gives no hint to create a template",
      };
}

/** Obligation d) — an edit that breaks conformance is refused: the issue is still conformant. */
export function gradeEditRefused({ before, after, attempted, conforms }) {
  if (!conforms(before))
    return { status: "unverified", detail: "the fixture issue was not conformant before the edit" };
  if (!attempted)
    return {
      status: "unverified",
      detail: "no jira.edit call in the turn; the gate was not exercised",
    };
  return conforms(after)
    ? { status: "green", detail: "the edit was refused; the issue is still conformant" }
    : { status: "red", detail: "the edit was applied and the issue is no longer conformant" };
}

/** Obligation e) — the same request twice leaves exactly one issue with its title. */
export function gradeComposerRerun({ title, afterSecond, first, second }) {
  const same = afterSecond.filter((issue) => issue.fields?.summary === title);
  if (first.created.length === 0)
    return { status: "unverified", detail: "the first run created no issue; nothing was shown" };
  if (same.length > 1 || second.created.length > 0 || second.duplicates.length > 0)
    return {
      status: "red",
      detail: `${same.length} issues carry the title; the second run created ${second.created.length}`,
    };
  return { status: "green", detail: `one issue carries the title; the second run created none` };
}

// ---------- fixtures ----------

/** The parents the requests name, created natively so no template and no model is involved. */
async function composerFixture(ctx) {
  const { epicName, epicLink } = ctx.truth.fieldIds;
  const epic = await ctx.nativeCreate({
    project: { key: PROJECT },
    issuetype: { name: "Epic" },
    summary: "Composer Eltern-Epic",
    [epicName]: "Composer Eltern-Epic",
    description: SYNTHETIC_BODY(requiredSections("Epic")),
  });
  const task = await ctx.nativeCreate({
    project: { key: PROJECT },
    issuetype: { name: "Task" },
    summary: "Composer Eltern-Aufgabe",
    [epicLink]: epic,
    description: SYNTHETIC_BODY(requiredSections("Task")),
  });
  return { epic, task, epicLink };
}

const templatesOf = (_ctx, fixture, options) =>
  composerTemplates(PROJECT, fixture.epicLink, options);

/** One fresh composer Chat and one turn; the issues of the type before/after are read from Jira. */
async function composerTurn(ctx, fixture, { type, mode, prompt, during }) {
  const chat = await ctx.freshChat(mode);
  const before = await snapshotBefore(ctx, typeQuery(type));
  const turn = await ctx.turn(chat, prompt, during);
  const issues = turnIssues({
    before,
    issues: await ctx.search(typeQuery(type), composerFields(fixture.epicLink)),
    exchanges: turn.toolExchanges,
  });
  return { turn, issues };
}

const part = (label, covers, grade) => ({ label, covers, ...grade });

// ---------- journeys ----------

/** C01: every type is created conformant by a plain titled instruction, all templates active. */
async function createEveryType(ctx) {
  const fixture = await composerFixture(ctx);
  return withTemplates(ctx.http, templatesOf(ctx, fixture), async () => {
    const runs = await sequentially(COMPOSER_TYPES, async (type) => {
      const title = `Composer ${type}`;
      const { turn, issues } = await composerTurn(ctx, fixture, {
        type,
        mode: "autonomous-delivery",
        prompt: createPrompt(type, title, fixture),
      });
      const grade = gradeComposerCreate({
        type,
        issues,
        conforms: composerConformity(type, fixture),
        related: composerRelation(type, fixture),
      });
      return { turn, part: part(`create ${type}`, [`create-conformant-${typeSlug(type)}`], grade) };
    });
    return aggregateParts(
      runs.map((run) => run.part),
      runs.map((run) => run.turn),
    );
  });
}

/** C02: a violating request is refused before any card or effect, per type and per mode. */
async function refuseViolations(ctx) {
  const fixture = await composerFixture(ctx);
  return withTemplates(ctx.http, templatesOf(ctx, fixture), async () => {
    const cases = COMPOSER_TYPES.flatMap((type) =>
      COMPOSER_MODES.map((entry) => ({ type, ...entry })),
    );
    const runs = await sequentially(cases, async ({ type, mode, key, label }) => {
      const title = `Schnelltest ${type} ${key}`;
      const { turn, issues } = await composerTurn(ctx, fixture, {
        type,
        mode,
        prompt: violationPrompt(type, title, fixture),
      });
      const grade = gradeComposerRefusal({
        exchanges: turn.toolExchanges,
        issues: issues.credited,
        template: `${PROJECT}/${type}`,
        conforms: composerConformity(type, fixture),
      });
      return {
        turn,
        part: part(`${type} in ${label}`, [`refused-${typeSlug(type)}-${key}`], grade),
      };
    });
    return aggregateParts(
      runs.map((run) => run.part),
      runs.map((run) => run.turn),
    );
  });
}

/** C03: with no template for the type the write is refused and the answer names the way out. */
async function refuseWithoutTemplate(ctx) {
  const fixture = await composerFixture(ctx);
  const governed = (await listTemplates(ctx.http)).filter(
    (entry) => entry.project?.toUpperCase() === PROJECT,
  );
  if (governed.length > 0)
    return result(
      "unverified",
      NO_TURN,
      `${governed.length} templates already govern ${PROJECT}; the precondition does not hold`,
      [],
    );
  const runs = await sequentially(COMPOSER_TYPES, async (type) => {
    const { turn, issues } = await composerTurn(ctx, fixture, {
      type,
      mode: "autonomous-delivery",
      prompt: createPrompt(type, `Ohne Vorlage ${type}`, fixture),
    });
    const grade = gradeNoTemplate({ issues, answer: turn.answer });
    return {
      turn,
      part: part(`${type} without template`, [`no-template-refused-${typeSlug(type)}`], grade),
    };
  });
  return aggregateParts(
    runs.map((run) => run.part),
    runs.map((run) => run.turn),
  );
}

const EDITS = Object.freeze([
  {
    label: "clear a required field",
    covers: "edit-clear-required-refused",
    prompt: (key) =>
      `Entferne im Jira-Projekt REQ die Beschreibung des Vorgangs ${key} vollständig; sie soll leer sein. Melde das Ergebnis oder den genauen Fehler.`,
  },
  {
    label: "remove the parent",
    covers: "edit-parent-refused",
    prompt: (key) =>
      `Entferne im Jira-Projekt REQ die Epic-Zuordnung des Vorgangs ${key}; er soll zu keinem Epic mehr gehören. Melde das Ergebnis oder den genauen Fehler.`,
  },
]);

/** C04: an edit that would make a conformant issue non-conformant is refused (templates govern edit). */
async function refuseBreakingEdits(ctx) {
  const fixture = await composerFixture(ctx);
  const conforms = composerConformity("Task", fixture);
  const templates = templatesOf(ctx, fixture, { activateOn: ["create", "edit"] });
  return withTemplates(ctx.http, templates, async () => {
    const runs = await sequentially(EDITS, async (edit) => {
      const read = async () =>
        (await ctx.search(`key = ${fixture.task}`, composerFields(fixture.epicLink)))[0];
      const before = await read();
      const chat = await ctx.freshChat("autonomous-delivery");
      const turn = await ctx.turn(chat, edit.prompt(fixture.task));
      const attempted = turn.toolExchanges.some((exchange) =>
        toolExchangeOf(exchange, "jira.edit"),
      );
      const grade = gradeEditRefused({ before, after: await read(), attempted, conforms });
      return { turn, part: part(edit.label, [edit.covers], grade) };
    });
    return aggregateParts(
      runs.map((run) => run.part),
      runs.map((run) => run.turn),
    );
  });
}

/** C05: the same create request from a Chat that remembers nothing creates no duplicate. */
async function rerunCreatesNoDuplicate(ctx) {
  const fixture = await composerFixture(ctx);
  const epic = composerTemplates(PROJECT, fixture.epicLink).find(
    (entry) => entry.issueType === "Epic",
  );
  return withTemplate(ctx.http, epic.markdown, epic.name, async () => {
    const title = "Composer Wiederholung";
    const prompt = createPrompt("Epic", title, fixture);
    const one = await composerTurn(ctx, fixture, {
      type: "Epic",
      mode: "autonomous-delivery",
      prompt,
    });
    const two = await composerTurn(ctx, fixture, {
      type: "Epic",
      mode: "autonomous-delivery",
      prompt,
    });
    const afterSecond = await ctx.search(typeQuery("Epic"), composerFields(fixture.epicLink));
    const grade = gradeComposerRerun({ title, afterSecond, first: one.issues, second: two.issues });
    return aggregateParts(
      [part("rerun", ["rerun-creates-no-duplicates"], grade)],
      [one.turn, two.turn],
    );
  });
}

/** C06: the three modes and a readable approval, with the document lane's grader and a plain request. */
async function modesAndApproval(ctx) {
  const fixture = await composerFixture(ctx);
  const epic = composerTemplates(PROJECT, fixture.epicLink).find(
    (entry) => entry.issueType === "Epic",
  );
  return withTemplate(ctx.http, epic.markdown, epic.name, () =>
    modesAndReadableApproval(ctx, {
      promptFor: (run) => createPrompt("Epic", `Composer Modus ${run.label}`, fixture),
    }),
  );
}

/** C07: S10 and S11 as they are, in a Chat that has only the Jira Pod. */
async function reportsOnJiraPodOnly(ctx) {
  const progress = await JOURNEYS.S10(ctx, await ctx.freshChat("autonomous-delivery"));
  const compliance = await JOURNEYS.S11(ctx, await ctx.freshChat("autonomous-delivery"));
  return aggregateParts(
    [
      { label: "S10 progress report", ...progress },
      { label: "S11 compliance report", ...compliance },
    ],
    [NO_TURN, NO_TURN],
  );
}

export const COMPOSER_JOURNEYS = Object.freeze({
  C01: createEveryType,
  C02: refuseViolations,
  C03: refuseWithoutTemplate,
  C04: refuseBreakingEdits,
  C05: rerunCreatesNoDuplicate,
  C06: modesAndApproval,
  C07: reportsOnJiraPodOnly,
});
export const COMPOSER_JOURNEY_IDS = Object.freeze(Object.keys(COMPOSER_JOURNEYS));
export { MODE_RUNS };
