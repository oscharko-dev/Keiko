// Story step of the limit run: three Stories under existing Epics, each traced to a real
// requirement of the Lastenheft and each with one Sub-task. The model creates them in the ordinary
// Chat; only an independent native Jira readback grades them, never the model's account.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { privateJson } from "../private-json.mjs";
import { STRUCTURE_RULES } from "./corpus.mjs";
import {
  goldenProjectKey,
  gradeCriteria,
  loadGoldenManifest,
  requirementTrace,
  validateGoldenManifest,
} from "./golden-jira-oracle.mjs";
import { epicRequirementId, keyValid, nativeId, requiredFieldsValid } from "./hierarchy-bulk.mjs";
import { draftIdentity, sectionsPresent } from "./oracles.mjs";
import { STORY_STRUCTURE_RULE } from "./templates.mjs";

export const STORY_STEP = "ac4-story-bulk";
export const STORY_COUNT = 3;
const STORY_MARKER = /^\[([^\]\r\n]+)\] \[ST-([1-9])(-S1)?\](?:\s|$)/u;
const MIN_CRITERIA = 2;
const ERROR_DETAIL_CHARS = 160;

function requireFact(condition, message) {
  if (!condition) throw new TypeError(message);
}

/** Evenly spread requirements that carry at least two criteria, so verbatim copying is observable. */
export function selectStoryRequirements(requirements, count = STORY_COUNT) {
  const candidates = requirements.filter(
    (requirement) => requirement.acceptanceCriteria.length >= MIN_CRITERIA,
  );
  requireFact(candidates.length >= count, "story-requirements-unavailable");
  return Array.from(
    { length: count },
    (_, index) => candidates[Math.floor((index * candidates.length) / count)],
  );
}

function epicFor(requirement, epics, projectKey) {
  const matches = epics.filter(
    (issue) =>
      issue?.fields?.issuetype?.name === "Epic" && epicRequirementId(issue) === requirement.id,
  );
  requireFact(matches.length === 1, "story-epic-missing-or-ambiguous");
  const [epic] = matches;
  requireFact(nativeId(epic.id) && keyValid(epic.key, projectKey), "story-epic-invalid");
  return { id: epic.id, key: epic.key };
}

function storyRow(requirement, epic, number) {
  const marker = `[${requirement.id}] [ST-${number}]`;
  return {
    reference: `${requirement.id}/ST-${number}`,
    marker,
    requirementId: requirement.id,
    type: "Story",
    epicKey: epic.key,
    summary: `${marker} ${requirement.title}`,
    acceptanceCriteria: requirement.acceptanceCriteria,
    source: { sectionPath: requirement.sectionPath, pdf: requirement.layout?.pdf },
  };
}

function subtaskRow(requirement, story) {
  const marker = `[${requirement.id}] [ST-${story.reference.split("ST-")[1]}-S1]`;
  return {
    reference: `${story.reference}-S1`,
    marker,
    requirementId: requirement.id,
    type: "Sub-task",
    epicKey: story.epicKey,
    parentReference: story.reference,
    summary: `${marker} ${requirement.title}`,
  };
}

/** Three Stories, each under the Epic of its requirement, and one Sub-task per Story. */
export function storyBulkPlan({ projectKey, requirements, epics, count = STORY_COUNT }) {
  goldenProjectKey(projectKey);
  requireFact(Array.isArray(epics), "story-epics-invalid");
  const selected = selectStoryRequirements(
    validateGoldenManifest({ requirementCount: requirements?.length, requirements }),
    count,
  );
  const stories = selected.map((requirement, index) =>
    storyRow(requirement, epicFor(requirement, epics, projectKey), index + 1),
  );
  const subtasks = stories.map((story, index) => subtaskRow(selected[index], story));
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectKey, stories, subtasks }))
    .digest("hex");
  return { projectKey, stories, subtasks, digest };
}

function emptyCounts(plan) {
  return {
    expectedStories: plan.stories.length,
    expectedSubtasks: plan.subtasks.length,
    stories: 0,
    subtasks: 0,
    missing: 0,
    duplicates: 0,
    unexpected: 0,
    invalidIds: 0,
    invalidType: 0,
    invalidEpic: 0,
    invalidParent: 0,
    invalidTrace: 0,
    invalidCriteria: 0,
    invalidTemplate: 0,
    invalidRequired: 0,
  };
}

function markerOf(issue) {
  const match = STORY_MARKER.exec(issue?.fields?.summary ?? "");
  return match === null ? undefined : `${match[1]}/ST-${match[2]}${match[3] ?? ""}`;
}

function identityValid(issue, projectKey) {
  return (
    nativeId(issue?.id) &&
    keyValid(issue?.key, projectKey) &&
    issue.fields?.project?.key === projectKey
  );
}

function recordIdentity(issue, projectKey, seen, counts) {
  if (!identityValid(issue, projectKey)) counts.invalidIds += 1;
  const draftId = draftIdentity(issue);
  const repeated =
    seen.keys.has(issue.key) ||
    seen.ids.has(issue.id) ||
    (draftId !== undefined && seen.draftIds.has(draftId));
  if (repeated) counts.duplicates += 1;
  seen.keys.add(issue.key);
  seen.ids.add(issue.id);
  if (draftId !== undefined) seen.draftIds.add(draftId);
}

/** No earlier step creates a Story, so a Story or a marked issue outside the plan is a stray. */
function strayIssue(issue, reference, allowed) {
  if (reference === undefined) return issue.fields?.issuetype?.name === "Story";
  return !allowed.has(reference);
}

/** Indexes the project's issues by story reference; counts identity faults, repeats and strays. */
function indexIssues(plan, issues, allowed, counts) {
  const byReference = new Map();
  const seen = { keys: new Set(), ids: new Set(), draftIds: new Set() };
  for (const issue of issues) {
    recordIdentity(issue, plan.projectKey, seen, counts);
    const reference = markerOf(issue);
    if (strayIssue(issue, reference, allowed)) counts.unexpected += 1;
    if (reference === undefined || !allowed.has(reference)) continue;
    if (byReference.has(reference)) counts.duplicates += 1;
    byReference.set(reference, issue);
  }
  return byReference;
}

function inspectTrace(issue, requirement, counts) {
  const trace = requirementTrace(issue.fields.description ?? "", requirement);
  if (!trace.id || !trace.source) counts.invalidTrace += 1;
  const criteria = { acPresent: 0, acDuplicated: 0, acUnexpected: 0 };
  gradeCriteria(trace.body, requirement, criteria);
  if (
    criteria.acPresent !== requirement.acceptanceCriteria.length ||
    criteria.acDuplicated !== 0 ||
    criteria.acUnexpected !== 0
  )
    counts.invalidCriteria += 1;
}

function inspectStory(row, issue, requirement, context, counts) {
  counts.stories += 1;
  if (issue.fields.issuetype?.name !== "Story") counts.invalidType += 1;
  if (issue.fields[context.epicLinkField] !== row.epicKey) counts.invalidEpic += 1;
  if (!sectionsPresent(issue.fields.description, STORY_STRUCTURE_RULE.sections))
    counts.invalidTemplate += 1;
  if (!requiredFieldsValid(issue, context.requiredFieldsByType)) counts.invalidRequired += 1;
  inspectTrace(issue, requirement, counts);
}

function subtaskParentValid(issue, storyIssue) {
  const parent = issue.fields.parent;
  const parentType = parent?.fields?.issuetype?.name;
  return (
    storyIssue !== undefined &&
    parent?.key === storyIssue.key &&
    (parentType === undefined || parentType === "Story")
  );
}

function inspectSubtask(issue, storyIssue, context, counts) {
  counts.subtasks += 1;
  if (issue.fields.issuetype?.name !== "Sub-task") counts.invalidType += 1;
  if (!subtaskParentValid(issue, storyIssue)) counts.invalidParent += 1;
  if (!sectionsPresent(issue.fields.description, STRUCTURE_RULES.Task.sections))
    counts.invalidTemplate += 1;
  if (!requiredFieldsValid(issue, context.requiredFieldsByType)) counts.invalidRequired += 1;
}

function inspectRows(rows, byReference, requirements, context, counts) {
  for (const row of rows) {
    const issue = byReference.get(row.reference);
    if (issue === undefined) {
      counts.missing += 1;
      continue;
    }
    if (row.type === "Story")
      inspectStory(row, issue, requirements.get(row.requirementId), context, counts);
    else inspectSubtask(issue, byReference.get(row.parentReference), context, counts);
  }
}

/** Expected rows through `stage`: the Stories, then the Stories with their Sub-tasks. */
export function storyRows(plan, stage) {
  return stage === "stories" ? plan.stories : [...plan.stories, ...plan.subtasks];
}

/** The rows `stage` itself writes: the Stories first, then their Sub-tasks. */
export const stageRows = (plan, stage) => (stage === "stories" ? plan.stories : plan.subtasks);

export function inspectStoryBulk({ plan, issues, requirements, stage, ...context }) {
  requireFact(Array.isArray(issues), "story-read-invalid");
  const counts = emptyCounts(plan);
  const rows = storyRows(plan, stage);
  const byReference = indexIssues(plan, issues, new Set(rows.map((row) => row.reference)), counts);
  const byRequirement = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  inspectRows(rows, byReference, byRequirement, context, counts);
  const faults = Object.entries(counts)
    .filter(([name]) => name !== "stories" && name !== "subtasks" && !name.startsWith("expected"))
    .reduce((sum, [, count]) => sum + count, 0);
  return { ok: faults === 0, counts, byReference };
}

/**
 * Strict native oracle: Story and Sub-task types, the Epic link of every Story, the parent of
 * every Sub-task, the template sections and required fields as Jira holds them, the traceability
 * footer of the requirement, the acceptance criteria verbatim, and no duplicate or stray issue.
 */
export function gradeStoryBulk(input) {
  const { ok, counts } = inspectStoryBulk(input);
  return { ok, counts };
}

function instructionFor(row, byReference) {
  const common = {
    requirementId: row.requirementId,
    summary: row.summary,
    issueType: row.type,
    descriptionSections:
      row.type === "Story" ? STORY_STRUCTURE_RULE.sections : STRUCTURE_RULES.Task.sections,
  };
  if (row.type === "Sub-task")
    return { ...common, parentStoryKey: byReference.get(row.parentReference)?.key };
  return {
    ...common,
    epicKey: row.epicKey,
    acceptanceCriteria: row.acceptanceCriteria,
    source: row.source,
  };
}

/** The Chat request of one stage; the Sub-task stage names the Story keys the readback observed. */
export function storyPrompt(plan, stage, byReference = new Map()) {
  const rows = stageRows(plan, stage);
  const common =
    `Erstelle im Jira-Projekt ${plan.projectKey} genau die folgenden ${rows.length} Vorgänge ` +
    "über die vorhandenen Jira-Chat-Werkzeuge und den geltenden Freigabepfad. " +
    "Lies die zugehörigen Anforderungen aus dem bereits bereitgestellten Lastenheft. " +
    "Übernimm jede Zusammenfassung exakt und folge den aktuell installierten Vorlagen. " +
    "Fülle alle aktuell erforderlichen nativen Create-Felder und jeden genannten " +
    "Beschreibungsabschnitt mit fachlichem Inhalt aus der genannten Quelle. " +
    "Binde requirementIds an die eine Anforderung des jeweiligen Vorgangs, damit Keiko die " +
    "Rückverfolgbarkeit selbst schreibt. ";
  const specific =
    stage === "stories"
      ? "Eine Story gehört über das native Epic-Link-Feld zum genannten Epic. Übernimm jedes " +
        "Abnahmekriterium wörtlich als eigenen Listenpunkt unter Akzeptanzkriterien. "
      : "Ein Sub-task gehört ausschließlich über parent zur exakt genannten Story, niemals " +
        "direkt zu einem Epic. ";
  const closing =
    "Erstelle keine weiteren Vorgänge. Lehnt Keiko einen Entwurf vor dem Schreiben mit einem " +
    "Korrekturhinweis ab, folge dem Hinweis und sende ihn erneut. Bei einem fehlgeschlagenen " +
    "oder unklaren Schreibergebnis stoppe, ohne einen Create-Aufruf zu wiederholen.\n";
  return (
    common +
    specific +
    closing +
    JSON.stringify(rows.map((row) => instructionFor(row, byReference)))
  );
}

function metadataReady(truth) {
  return (
    /^customfield_[1-9]\d*$/u.test(truth?.fieldIds?.epicLink ?? "") &&
    ["Story", "Sub-task"].every((type) => {
      const fields = truth.requiredFieldsByType?.[type];
      return Array.isArray(fields) && fields.includes("summary");
    })
  );
}

function contextReady(ctx) {
  const ports = [ctx.turn, ctx.search, ctx.intent?.update, ctx.intent?.record];
  return (
    typeof ctx.projectKey === "string" &&
    typeof ctx.sessionDir === "string" &&
    typeof ctx.chat?.id === "string" &&
    ports.every((port) => typeof port === "function")
  );
}

function publicResult(status, reason, counts = {}, evidenceFile) {
  return {
    step: STORY_STEP,
    status,
    detail: `${reason}; stories=${counts.stories ?? 0}; subtasks=${counts.subtasks ?? 0}`,
    counts,
    ...(evidenceFile === undefined ? {} : { evidenceFile }),
  };
}

async function finish(ctx, status, reason, counts = {}, digest) {
  const evidenceFile = join(ctx.sessionDir, "story-bulk.json");
  const result = publicResult(status, reason, counts, evidenceFile);
  privateJson(evidenceFile, { schemaVersion: 1, ...result, ...(digest ? { digest } : {}) });
  await ctx.intent.record(STORY_STEP, result);
  return result;
}

const freshIssues = (ctx) => {
  ctx.signal?.throwIfAborted();
  return ctx.search(`project = "${ctx.projectKey}" ORDER BY id ASC`, "*all");
};

function savedCheckpoint(ctx, plan) {
  const saved = ctx.intent.state?.storyBulk;
  if (saved === undefined) return { phase: "ready", stage: "stories", digest: plan.digest };
  requireFact(
    saved.digest === plan.digest &&
      ["ready", "writing", "complete"].includes(saved.phase) &&
      ["stories", "all"].includes(saved.stage),
    "story-checkpoint-mismatch",
  );
  return saved;
}

function gradeInput(ctx, plan, requirements, issues, stage) {
  return {
    plan,
    issues,
    requirements,
    stage,
    epicLinkField: ctx.truth.fieldIds.epicLink,
    requiredFieldsByType: ctx.truth.requiredFieldsByType,
  };
}

/** One stage: skip it when its rows are already valid, refuse to replay a partial or unknown one. */
async function runStage(ctx, run, stage) {
  const { plan, requirements } = run;
  const rows = stageRows(plan, stage);
  const before = inspectStoryBulk(
    gradeInput(ctx, plan, requirements, await freshIssues(ctx), stage),
  );
  const found = stage === "stories" ? before.counts.stories : before.counts.subtasks;
  if (found === rows.length && before.ok) return before;
  if (found > 0 || (run.saved.phase === "writing" && run.saved.stage === stage))
    return { ...before, ok: false, unreconciled: true };
  await ctx.checkLicense?.();
  await ctx.intent.update({ storyBulk: { phase: "writing", stage, digest: plan.digest } });
  await ctx.turn(ctx.chat, storyPrompt(plan, stage, before.byReference), {
    operations: ["jira.draft", "jira.create"],
    ...ctx.turnOptions,
  });
  const after = inspectStoryBulk(
    gradeInput(ctx, plan, requirements, await freshIssues(ctx), stage),
  );
  if (after.ok)
    await ctx.intent.update({ storyBulk: { phase: "ready", stage, digest: plan.digest } });
  return after;
}

async function runStages(ctx, run, stages) {
  if (stages.length === 0) return undefined;
  const [stage, ...rest] = stages;
  const observed = await runStage(ctx, run, stage);
  if (!observed.ok) return observed;
  return runStages(ctx, run, rest);
}

async function ensureTemplates(ctx, options) {
  const ensure =
    options.ensureTemplates ?? (await import("../story-templates.mjs")).ensureStoryTemplates;
  return ensure(ctx);
}

async function runPrepared(ctx, options) {
  const manifest = options.manifest ?? loadGoldenManifest();
  const requirements = validateGoldenManifest(manifest);
  const templates = await ensureTemplates(ctx, options);
  const plan = storyBulkPlan({
    projectKey: ctx.projectKey,
    requirements,
    epics: (await freshIssues(ctx)).filter((issue) => issue.fields?.issuetype?.name === "Epic"),
  });
  const saved = savedCheckpoint(ctx, plan);
  const run = { plan, requirements, saved };
  const failed = await runStages(ctx, run, ["stories", "all"]);
  if (failed !== undefined) {
    const reason = failed.unreconciled ? "unreconciled-stories" : "native-oracle-refused";
    return finish(
      ctx,
      failed.unreconciled ? "unverified" : "red",
      reason,
      failed.counts,
      plan.digest,
    );
  }
  const grade = gradeStoryBulk(gradeInput(ctx, plan, requirements, await freshIssues(ctx), "all"));
  if (grade.ok)
    await ctx.intent.update({
      storyBulk: { phase: "complete", stage: "all", digest: plan.digest },
    });
  return finish(
    ctx,
    grade.ok ? "green" : "red",
    "native-oracle",
    { ...grade.counts, ...templates },
    plan.digest,
  );
}

function errorSummary(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  return text.replaceAll(/[\r\n\p{Cc}]+/gu, " ").slice(0, ERROR_DETAIL_CHARS);
}

/** Template installation, two browser turns and the complete native oracle; never replays a write. */
export async function runStoryBulk(ctx, options = {}) {
  if (!contextReady(ctx)) return publicResult("unverified", "context-unavailable");
  if (!metadataReady(ctx.truth)) return finish(ctx, "unverified", "create-metadata-unavailable");
  try {
    return await runPrepared(ctx, options);
  } catch (error) {
    // A pending write remains pending: neither a lost response nor a restart authorizes replay.
    return finish(ctx, "unverified", `interrupted-or-invalid-evidence: ${errorSummary(error)}`);
  }
}
