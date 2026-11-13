// The Composer lane's journeys (#4369, Release 1): Jira writes made from the Chat composer by plain
// instruction, in a Chat bound only to the Jira Pod. No Knowledge Pod, no requirements document and
// no structure skill: the lead's templates are the only structure. Every verdict is read from Jira
// (`ctx.search`, `ctx.nativeGet`) by the graders of composer-graders.mjs, never from the product's
// own account. The refusal, repair and approval graders of the document lane are reused by
// parameter, not copied. The lane assumes no model and runs with any lab gateway configuration.
import { actorDetails } from "../lab-client.mjs";
import {
  COMPOSER_TYPES,
  composerConformity,
  composerFields,
  composerTemplates,
  createPrompt,
  requiredSections,
  typeSlug,
  unrepairablePrompt,
  violationPrompt,
} from "./composer-templates.mjs";
import {
  gradeAttachmentRefusal,
  gradeComment,
  gradeComposerCreate,
  gradeComposerRefusal,
  gradeComposerRerun,
  gradeEditBreaking,
  gradeEditPreexisting,
  gradeMultiCreate,
  gradeNoTemplate,
  gradeUnrepairable,
  gradeUngovernedChange,
  gradeWatcher,
  composerRelation,
  ofType,
} from "./composer-graders.mjs";
import { JOURNEYS } from "./journey-checks.mjs";
import { NO_TURN, aggregateParts, sequentially, snapshotBefore } from "./journey-support.mjs";
import { modesAndReadableApproval } from "./modes.mjs";
import { turnIssues } from "./oracles.mjs";
import { listTemplates, removeTemplate, withTemplates } from "./templates.mjs";

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

/** The types and modes of this run: all of them, or the ones the run selected (`--types`, `--modes`). */
export function composerSelection(ctx) {
  const wanted = ctx.composerSelection ?? {};
  return {
    types: COMPOSER_TYPES.filter((type) => !wanted.types || wanted.types.includes(typeSlug(type))),
    modes: COMPOSER_MODES.filter((entry) => !wanted.modes || wanted.modes.includes(entry.key)),
  };
}

// ---------- fixtures and templates ----------

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
  // A Story: the one parent a Sub-task must not be created under (the unrepairable request of C01).
  const story = await ctx.nativeCreate({
    project: { key: PROJECT },
    issuetype: { name: "Story" },
    summary: "Composer Eltern-Story",
    [epicLink]: epic,
    description: SYNTHETIC_BODY(requiredSections("Story")),
  });
  return { epic, task, story, epicLink };
}

const OWN_TEMPLATE = /Composer-/u;
const BASELINE_TEMPLATE = /baseline/iu;
const labelOf = (entry) =>
  [entry.name, entry.fileName, entry.displayName, entry.title]
    .filter((value) => typeof value === "string")
    .join(" ");

/**
 * The templates of the work project, sorted: this lane's own (by its lab name), a lab baseline set
 * (named as such) and everything else. A template the lane did not create is never touched.
 */
export async function templateState(ctx) {
  const entries = (await listTemplates(ctx.http)).filter(
    (entry) => entry.project?.toUpperCase() === PROJECT,
  );
  const own = entries.filter((entry) => OWN_TEMPLATE.test(labelOf(entry)));
  const baseline = entries.filter(
    (entry) => !own.includes(entry) && BASELINE_TEMPLATE.test(labelOf(entry)),
  );
  return {
    own,
    baseline,
    foreign: entries.filter((e) => !own.includes(e) && !baseline.includes(e)),
  };
}

/**
 * Makes the library fit the journey: leftovers of an earlier killed run of this lane are removed by
 * their lab name, and a template of a type under test that the lane did not create stops the journey
 * as a lab state (`invalid`), never a verdict about the product. `ungoverned` types must have no
 * template at all, baseline included.
 */
export async function prepareTemplates(ctx, { types, ungoverned = [] }) {
  const state = await templateState(ctx);
  for (const entry of state.own) {
    if (entry.revision === undefined)
      throw new TypeError(
        "A leftover composer template cannot be removed: its revision is unknown",
      );
    await removeTemplate(ctx.http, { id: entry.id, revision: entry.revision });
  }
  const typeOf = (entry) => entry.issueType;
  const clash = state.foreign.filter(
    (entry) => types.includes(typeOf(entry)) || ungoverned.includes(typeOf(entry)),
  );
  if (clash.length > 0)
    throw new TypeError(
      `${clash.length} templates of the work project that the lane did not create govern a type under test`,
    );
  const baselined = state.baseline.filter((entry) => ungoverned.includes(typeOf(entry)));
  if (baselined.length > 0)
    throw new TypeError(
      "A baseline template governs a type that must have none; start the product without the baseline set",
    );
}

const templatesOf = (fixture, options) => composerTemplates(PROJECT, fixture.epicLink, options);

/** One fresh composer Chat and one turn; every issue the project gained is read natively. */
async function composerTurn(ctx, fixture, { mode = "autonomous-delivery", prompt, during }) {
  const chat = await ctx.freshChat(mode);
  const before = await snapshotBefore(ctx, `project = ${PROJECT}`);
  const turn = await ctx.turn(chat, prompt, during);
  const issues = turnIssues({
    before,
    issues: await ctx.search(`project = ${PROJECT}`, composerFields(fixture.epicLink)),
    exchanges: turn.toolExchanges,
  });
  return { turn, issues };
}

const part = (label, covers, grade) => ({ label, covers, ...grade });
const slugOf = typeSlug;
const parts = (runs) =>
  aggregateParts(
    runs.map((run) => run.part),
    runs.map((run) => run.turn),
  );

// ---------- journeys ----------

/** C01: every type is created conformant by a plain titled instruction, and one request creates several. */
async function createEveryType(ctx) {
  const fixture = await composerFixture(ctx);
  const { types } = composerSelection(ctx);
  await prepareTemplates(ctx, { types });
  return withTemplates(ctx.http, templatesOf(fixture), async () => {
    const singles = await sequentially(types, async (type) => {
      const { turn, issues } = await composerTurn(ctx, fixture, {
        prompt: createPrompt(type, `Composer ${type}`, fixture),
      });
      const grade = gradeComposerCreate({
        type,
        issues,
        conforms: composerConformity(type, fixture),
        related: composerRelation(type, fixture),
      });
      return { turn, part: part(`create ${type}`, [`create-conformant-${slugOf(type)}`], grade) };
    });
    const several = types.includes("Task") ? [await createSeveralTasks(ctx, fixture)] : [];
    const unrepairable = types.includes("Sub-task")
      ? [await unrepairableRequest(ctx, fixture)]
      : [];
    return parts([...singles, ...several, ...unrepairable]);
  });
}

/** A Sub-task under a Story cannot be created and cannot be repaired by the model: it must say why. */
async function unrepairableRequest(ctx, fixture) {
  const { turn, issues } = await composerTurn(ctx, fixture, {
    prompt: unrepairablePrompt("Composer Teilaufgabe unter Story", fixture),
  });
  const grade = gradeUnrepairable({
    created: issues.created,
    exchanges: turn.toolExchanges,
    answer: turn.answer,
  });
  return {
    turn,
    part: part("unrepairable request", ["refusal-readable-unrepairable"], grade),
  };
}

const SEVERAL_TITLES = ["Composer Teil A", "Composer Teil B", "Composer Teil C"];

/** One request, three Tasks under the named Epic: all created natively, every key listed. */
async function createSeveralTasks(ctx, fixture) {
  const { turn, issues } = await composerTurn(ctx, fixture, {
    prompt: `Lege im Jira-Projekt REQ drei Aufgaben (Vorgangstyp Task) mit den Titeln ${SEVERAL_TITLES.map((title) => `„${title}“`).join(", ")} im Epic ${fixture.epic} an. Melde alle Vorgangsschlüssel.`,
  });
  const grade = gradeMultiCreate({
    type: "Task",
    titles: SEVERAL_TITLES,
    issues,
    conforms: composerConformity("Task", fixture),
    related: composerRelation("Task", fixture),
    answer: turn.answer,
    exchanges: turn.toolExchanges,
  });
  return {
    turn,
    part: {
      label: "create several Tasks",
      covers: ["multi-create-all-created", "multi-create-keys-listed"],
      ...mergeVerdicts(grade.created, grade.listed),
    },
  };
}

/** Two verdicts as one part: red beats unverified beats green; the obligations stay named. */
function mergeVerdicts(...grades) {
  const order = ["red", "unverified", "green"];
  const status = order.find((entry) => grades.some((grade) => grade.status === entry));
  return { status, detail: grades.map((grade) => `${grade.status}: ${grade.detail}`).join("; ") };
}

/** C02: a violating request is refused before any card or effect, per type and per mode. */
async function refuseViolations(ctx) {
  const fixture = await composerFixture(ctx);
  const { types, modes } = composerSelection(ctx);
  await prepareTemplates(ctx, { types });
  return withTemplates(ctx.http, templatesOf(fixture), async () => {
    const cases = types.flatMap((type) => modes.map((entry) => ({ type, ...entry })));
    return parts(
      await sequentially(cases, async ({ type, mode, key, label }) => {
        const { turn, issues } = await composerTurn(ctx, fixture, {
          mode,
          prompt: violationPrompt(type, `Schnelltest ${type} ${key}`, fixture),
        });
        const grade = gradeComposerRefusal({
          type,
          exchanges: turn.toolExchanges,
          created: issues.created,
          template: `${PROJECT}/${type}`,
          conforms: composerConformity(type, fixture),
        });
        return {
          turn,
          part: part(`${type} in ${label}`, [`refused-${slugOf(type)}-${key}`], grade),
        };
      }),
    );
  });
}

/** C03: with no template for the type the create is refused by the gate, with the hint, in every mode. */
async function refuseWithoutTemplate(ctx) {
  const fixture = await composerFixture(ctx);
  const { types, modes } = composerSelection(ctx);
  await prepareTemplates(ctx, { types: [], ungoverned: types });
  const cases = types.flatMap((type) => modes.map((entry) => ({ type, ...entry })));
  return parts(
    await sequentially(cases, async ({ type, mode, key, label }) => {
      const { turn, issues } = await composerTurn(ctx, fixture, {
        mode,
        prompt: createPrompt(type, `Ohne Vorlage ${type} ${key}`, fixture),
      });
      const grade = gradeNoTemplate({
        created: issues.created,
        exchanges: turn.toolExchanges,
        answer: turn.answer,
      });
      return {
        turn,
        part: part(`${type} in ${label}`, [`no-template-${slugOf(type)}-${key}`], grade),
      };
    }),
  );
}

const EDIT_TITLE = "Composer geänderte Zusammenfassung";
const BUG_TITLE = "Composer Fehler geändert";
/** The three issues of the edit rules: a conformant Task, a Task with a pre-existing violation, a Bug. */
async function editFixtures(ctx, fixture) {
  const base = { project: { key: PROJECT }, [fixture.epicLink]: fixture.epic };
  const broken = await ctx.nativeCreate({
    ...base,
    issuetype: { name: "Task" },
    summary: "Composer Vorschaden",
    // The section Testhinweise is missing: a violation the edit below does not touch.
    description: SYNTHETIC_BODY(requiredSections("Task").filter((name) => name !== "Testhinweise")),
  });
  const bug = await ctx.nativeCreate({
    ...base,
    issuetype: { name: "Bug" },
    summary: "Composer Fehler ohne Vorlage",
    priority: { name: "High" },
    description: "Ohne Vorlage.",
  });
  return { task: fixture.task, broken, bug };
}

/** The two edits that would break a conformant Task: clear a section, remove the epic link. */
function breakingEdits(fixture, key) {
  const conforms = composerConformity("Task", fixture);
  const refusedBy =
    (ruleIds) =>
    ({ before, after, turn }) =>
      gradeEditBreaking({ before, after, exchanges: turn.toolExchanges, conforms, ruleIds });
  return [
    {
      key,
      label: "clear a required field",
      covers: "edit-breaking-refused-clear-field",
      prompt: `Entferne im Jira-Projekt REQ die Beschreibung des Vorgangs ${key} vollständig; sie soll leer sein. Melde das Ergebnis oder den genauen Fehler.`,
      grade: refusedBy(["section-missing", "section-empty", "field-missing"]),
    },
    {
      key,
      label: "remove the parent",
      covers: "edit-breaking-refused-parent",
      prompt: `Entferne im Jira-Projekt REQ die Epic-Zuordnung des Vorgangs ${key}; er soll zu keinem Epic mehr gehören. Melde das Ergebnis oder den genauen Fehler.`,
      grade: refusedBy(["parent-missing", "field-missing"]),
    },
  ];
}

/** The five edit rules: the issue to touch, the request, and the native grader that decides. */
function editCases(fixture, keys) {
  return [
    ...breakingEdits(fixture, keys.task),
    {
      key: keys.broken,
      label: "pre-existing violation in an untouched field",
      covers: "edit-preexisting-notice",
      prompt: `Ändere im Jira-Projekt REQ die Zusammenfassung des Vorgangs ${keys.broken} auf „${EDIT_TITLE}“. Melde das Ergebnis und nenne Auffälligkeiten.`,
      grade: ({ before, after, turn }) =>
        gradeEditPreexisting({
          before,
          after,
          touched: "summary",
          expected: EDIT_TITLE,
          remaining: "Testhinweise",
          remainingRule: "section-missing",
          exchanges: turn.toolExchanges,
          answer: turn.answer,
        }),
    },
    {
      key: keys.bug,
      label: "edit of a type without template",
      covers: "edit-no-template-passes",
      prompt: `Ändere im Jira-Projekt REQ die Zusammenfassung des Vorgangs ${keys.bug} auf „${BUG_TITLE}“. Melde das Ergebnis.`,
      grade: ({ before, after }) =>
        gradeUngovernedChange({ before, after, field: "summary", expected: BUG_TITLE }),
    },
    {
      key: keys.bug,
      label: "status change without template",
      covers: "status-change-no-template-passes",
      prompt: `Starte die Bearbeitung des Vorgangs ${keys.bug} im Jira-Projekt REQ: Setze ihn auf den Status „In Arbeit“ (In Progress). Melde das Ergebnis.`,
      grade: ({ before, after }) =>
        gradeUngovernedChange({ before, after, field: "status", expected: "indeterminate" }),
    },
  ];
}

/** C04: the owner's edit rules (templates govern create and edit; the Bug type has none). */
async function editRules(ctx) {
  const fixture = await composerFixture(ctx);
  const governed = templatesOf(fixture, { activateOn: ["create", "edit"] }).filter(
    (entry) => entry.issueType !== "Bug",
  );
  await prepareTemplates(ctx, {
    types: governed.map((entry) => entry.issueType),
    ungoverned: ["Bug"],
  });
  const keys = await editFixtures(ctx, fixture);
  const read = async (key) =>
    (await ctx.search(`key = ${key}`, `${composerFields(fixture.epicLink)},status`))[0];
  return withTemplates(ctx.http, governed, async () =>
    parts(
      await sequentially(editCases(fixture, keys), async (edit) => {
        const before = await read(edit.key);
        const { turn } = await composerTurn(ctx, fixture, { prompt: edit.prompt });
        const grade = edit.grade({ before, after: await read(edit.key), turn });
        return { turn, part: part(edit.label, [edit.covers], grade) };
      }),
    ),
  );
}

/** C05: the same create request from a Chat that remembers nothing creates no duplicate (a Task). */
async function rerunCreatesNoDuplicate(ctx) {
  const fixture = await composerFixture(ctx);
  await prepareTemplates(ctx, { types: ["Task"] });
  const task = templatesOf(fixture).filter((entry) => entry.issueType === "Task");
  return withTemplates(ctx.http, task, async () => {
    const title = "Composer Wiederholung";
    const prompt = createPrompt("Task", title, fixture);
    const one = await composerTurn(ctx, fixture, { prompt });
    const two = await composerTurn(ctx, fixture, { prompt });
    const afterSecond = await ctx.search(typeQuery("Task"), composerFields(fixture.epicLink));
    const grade = gradeComposerRerun({
      title,
      afterSecond,
      first: ofType(one.issues, "Task"),
      second: ofType(two.issues, "Task"),
    });
    return aggregateParts(
      [part("rerun", ["rerun-creates-no-duplicates"], grade)],
      [one.turn, two.turn],
    );
  });
}

/** C06: the three modes and a readable approval, with the document lane's grader and a plain Bug request. */
async function modesAndApproval(ctx) {
  const fixture = await composerFixture(ctx);
  await prepareTemplates(ctx, { types: ["Bug"] });
  const bug = templatesOf(fixture).filter((entry) => entry.issueType === "Bug");
  return withTemplates(ctx.http, bug, () =>
    modesAndReadableApproval(ctx, {
      query: typeQuery("Bug"),
      promptFor: (run) => createPrompt("Bug", `Composer Modus ${run.label}`, fixture),
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

const ACTOR = () => actorDetails("api").name;

/** C08: a watcher and a comment by plain instruction, verified natively; no template is involved. */
async function watchAndComment(ctx) {
  const fixture = await composerFixture(ctx);
  await prepareTemplates(ctx, { types: [] });
  const watchers = async () =>
    (await ctx.nativeGet(`/rest/api/2/issue/${fixture.task}/watchers`)).watchers;
  const commentsOf = async (key) =>
    (await ctx.nativeGet(`/rest/api/2/issue/${key}/comment`)).comments;
  // The fixture's other issue: a comment the model put there instead is on the wrong issue.
  const elsewhere = () => commentsOf(fixture.epic);
  if ((await watchers()).some((watcher) => watcher.name === ACTOR()))
    throw new TypeError(
      "The connected user already watches the fixture issue before the turn; a watcher cannot be proven",
    );
  const body = "Composer Kommentar";
  const send = async (prompt) => (await composerTurn(ctx, fixture, { prompt })).turn;
  const added = await send(
    `Füge mich im Jira-Projekt REQ als Beobachter zum Vorgang ${fixture.task} hinzu.`,
  );
  const addGrade = gradeWatcher({
    watchers: await watchers(),
    actor: ACTOR(),
    expectPresent: true,
  });
  const written = await send(
    `Schreibe am Vorgang ${fixture.task} im Jira-Projekt REQ den Kommentar „${body}“.`,
  );
  const commentGrade = gradeComment({
    comments: await commentsOf(fixture.task),
    elsewhere: await elsewhere(),
    actor: ACTOR(),
    body,
  });
  const removed = await send(`Entferne mich wieder als Beobachter vom Vorgang ${fixture.task}.`);
  const removeGrade =
    addGrade.status === "green"
      ? gradeWatcher({ watchers: await watchers(), actor: ACTOR(), expectPresent: false })
      : {
          status: "unverified",
          detail: "the watcher was never added, so its removal proves nothing",
        };
  return parts([
    { turn: added, part: part("add me as a watcher", ["watcher-added"], addGrade) },
    { turn: written, part: part("write a comment", ["comment-written"], commentGrade) },
    { turn: removed, part: part("remove the watcher", ["watcher-removed"], removeGrade) },
  ]);
}

/** C09: a request to attach a file is answered readably and nothing reaches Jira. */
async function attachmentRefused(ctx) {
  const fixture = await composerFixture(ctx);
  await prepareTemplates(ctx, { types: [] });
  const count = async () =>
    (await ctx.nativeGet(`/rest/api/2/issue/${fixture.task}?fields=attachment`)).fields?.attachment
      ?.length ?? 0;
  const before = await count();
  const { turn } = await composerTurn(ctx, fixture, {
    prompt: `Hänge die Datei „bericht.pdf“ an den Vorgang ${fixture.task} im Jira-Projekt REQ an.`,
  });
  const grade = gradeAttachmentRefusal({
    before,
    after: await count(),
    answer: turn.answer,
    exchanges: turn.toolExchanges,
  });
  return aggregateParts([part("attach a file", ["attachment-refused"], grade)], [turn]);
}

export const COMPOSER_JOURNEYS = Object.freeze({
  C01: createEveryType,
  C02: refuseViolations,
  C03: refuseWithoutTemplate,
  C04: editRules,
  C05: rerunCreatesNoDuplicate,
  C06: modesAndApproval,
  C07: reportsOnJiraPodOnly,
  C08: watchAndComment,
  C09: attachmentRefused,
});
export const COMPOSER_JOURNEY_IDS = Object.freeze(Object.keys(COMPOSER_JOURNEYS));
/** Journeys that need a product started without the lab's baseline template set (#4369). */
export const COMPOSER_WITHOUT_BASELINE = Object.freeze(["C03", "C04"]);
