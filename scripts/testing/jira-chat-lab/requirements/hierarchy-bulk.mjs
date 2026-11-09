// AC4 observes the native Jira graph independently of the browser turns that request it.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { privateJson } from "../private-json.mjs";
import { STRUCTURE_RULES } from "./corpus.mjs";
import {
  GOLDEN_REQUIREMENT_COUNT,
  goldenProjectKey,
  loadGoldenManifest,
  validateGoldenManifest,
} from "./golden-jira-oracle.mjs";
import { gradeBug } from "./hierarchy.mjs";
import { draftIdentity, sectionsPresent } from "./oracles.mjs";

const STEP = "ac4-hierarchy-bulk";
const TYPES = ["Task", "Bug", "Sub-task"];
const BATCH_SIZE = 25;
const EPIC_MARKER = /^\[([^\]\r\n]+)\](?:\s|$)/;
const CHILD_MARKER = /^\[([^\]\r\n]+)\] \[HB-(T[12](?:-S1)?|B1)\](?:\s|$)/;

function epicRequirementId(epic) {
  return EPIC_MARKER.exec(epic?.fields?.summary ?? "")?.[1];
}

function projectValid(projectKey) {
  try {
    goldenProjectKey(projectKey);
    return true;
  } catch {
    return false;
  }
}

function nativeId(value) {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}

function keyValid(key, projectKey) {
  return typeof key === "string" && new RegExp(`^${projectKey}-[1-9]\\d*$`).test(key);
}

function requirementMap(requirements) {
  const validated = validateGoldenManifest({
    requirementCount: requirements?.length,
    requirements,
  });
  return new Map(validated.map((requirement) => [requirement.id, requirement]));
}

function bindEpics(projectKey, requirements, epics) {
  if (!Array.isArray(epics)) throw new TypeError("hierarchy-epics-invalid");
  const bound = new Map();
  const keys = new Set();
  const ids = new Set();
  for (const epic of epics) {
    const requirementId = epicRequirementId(epic);
    if (
      bound.has(requirementId) ||
      keys.has(epic.key) ||
      ids.has(epic.id) ||
      !epicMatchesRequirement(epic, requirementId, requirements, projectKey)
    )
      throw new TypeError("hierarchy-epics-invalid");
    bound.set(requirementId, { requirementId, id: epic.id, key: epic.key });
    keys.add(epic.key);
    ids.add(epic.id);
  }
  if (bound.size !== requirements.size) throw new TypeError("hierarchy-epics-incomplete");
  return bound;
}

function epicMatchesRequirement(epic, requirementId, requirements, projectKey) {
  return (
    requirements.has(requirementId) &&
    nativeId(epic.id) &&
    keyValid(epic.key, projectKey) &&
    epic.fields?.issuetype?.name === "Epic"
  );
}

function child(requirement, epic, suffix, type, parentReference) {
  return {
    reference: `${requirement.id}/${suffix}`,
    marker: `[${requirement.id}] [HB-${suffix}]`,
    requirementId: requirement.id,
    type,
    epicKey: epic.key,
    parentReference,
    summary: `[${requirement.id}] [HB-${suffix}] ${requirement.title}`,
    source: {
      sectionPath: requirement.sectionPath ?? [],
      pdf: requirement.layout?.pdf,
    },
  };
}

function plannedChildren(requirements, epics) {
  const tasks = [];
  const bugs = [];
  const subtasks = [];
  let epicNumber = 0;
  for (const requirement of requirements.values()) {
    const epic = epics.get(requirement.id);
    epicNumber += 1;
    const ownTasks = epicNumber % 3 === 0 ? ["T1", "T2"] : ["T1"];
    for (const suffix of ownTasks) {
      const task = child(requirement, epic, suffix, "Task");
      tasks.push(task);
      if (tasks.length % 5 === 0)
        subtasks.push(child(requirement, epic, `${suffix}-S1`, "Sub-task", task.reference));
    }
    if (epicNumber % 8 === 0)
      bugs.push(child(requirement, epic, "B1", "Bug", `${requirement.id}/T1`));
  }
  return [...tasks, ...bugs, ...subtasks];
}

/** One Task per Epic, a second on every third Epic, a Bug every eighth, a Sub-task every fifth Task. */
export function hierarchyBulkPlan({ projectKey, requirements, epics }) {
  if (!projectValid(projectKey)) throw new TypeError("hierarchy-project-invalid");
  const requirementById = requirementMap(requirements);
  const epicByRequirement = bindEpics(projectKey, requirementById, epics);
  const children = plannedChildren(requirementById, epicByRequirement);
  const boundEpics = [...requirementById.keys()].map((id) => epicByRequirement.get(id));
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectKey, epics: boundEpics, children }))
    .digest("hex");
  return { projectKey, epics: boundEpics, children, digest };
}

function filled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function requiredFieldsValid(issue, requiredFieldsByType) {
  const fields = issue.fields;
  const required = requiredFieldsByType[fields.issuetype?.name] ?? [];
  return ["summary", "description", "issuetype", ...required].every((name) => filled(fields[name]));
}

function markerOf(issue) {
  const match = CHILD_MARKER.exec(issue.fields?.summary ?? "");
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function emptyCounts(plan, expected) {
  return {
    expectedEpics: plan.epics.length,
    expectedTasks: expected.filter((row) => row.type === "Task").length,
    expectedBugs: expected.filter((row) => row.type === "Bug").length,
    expectedSubtasks: expected.filter((row) => row.type === "Sub-task").length,
    epics: 0,
    tasks: 0,
    bugs: 0,
    subtasks: 0,
    missing: 0,
    duplicates: 0,
    unexpected: 0,
    invalidIds: 0,
    invalidMetadata: 0,
    invalidEpics: 0,
    invalidRequired: 0,
    invalidStructure: 0,
    invalidParents: 0,
    invalidLinks: 0,
  };
}

function identityIndex(plan, issues, expected, counts) {
  const byReference = new Map();
  const seen = { keys: new Set(), ids: new Set(), draftIds: new Set() };
  const allowed = new Set(expected.map((row) => row.reference));
  const epics = new Map(plan.epics.map((epic) => [epic.key, epic]));
  for (const issue of issues) {
    inspectIdentity(issue, plan.projectKey, seen, counts);
    if (issue?.fields?.issuetype?.name === "Epic") {
      inspectEpic(issue, epics, counts);
      continue;
    }
    const reference = markerOf(issue);
    if (!allowed.has(reference)) counts.unexpected += 1;
    if (byReference.has(reference)) counts.duplicates += 1;
    byReference.set(reference, issue);
  }
  counts.missing += [...epics.keys()].filter((key) => !seen.keys.has(key)).length;
  return byReference;
}

function inspectIdentity(issue, projectKey, seen, counts) {
  if (!nativeIdentityValid(issue, projectKey)) counts.invalidIds += 1;
  const draftId = draftIdentity(issue);
  if (seen.keys.has(issue.key) || seen.ids.has(issue.id) || (draftId && seen.draftIds.has(draftId)))
    counts.duplicates += 1;
  seen.keys.add(issue.key);
  seen.ids.add(issue.id);
  if (draftId) seen.draftIds.add(draftId);
}

function nativeIdentityValid(issue, projectKey) {
  return (
    nativeId(issue?.id) &&
    keyValid(issue?.key, projectKey) &&
    issue.fields?.project?.key === projectKey
  );
}

function inspectEpic(issue, epics, counts) {
  counts.epics += 1;
  const expected = epics.get(issue.key);
  if (
    expected === undefined ||
    expected.id !== issue.id ||
    epicRequirementId(issue) !== expected.requirementId
  )
    counts.invalidEpics += 1;
}

function inspectChild(row, issue, byReference, epicLinkField, required, counts) {
  if (issue === undefined) {
    counts.missing += 1;
    return;
  }
  const counter = { Task: "tasks", Bug: "bugs", "Sub-task": "subtasks" }[row.type];
  counts[counter] += 1;
  if (issue.fields.issuetype?.name !== row.type || !requiredFieldsValid(issue, required))
    counts.invalidRequired += 1;
  const rule = structureRule(row.type);
  if (!sectionsPresent(issue.fields.description, rule.sections)) counts.invalidStructure += 1;
  const taskKey = byReference.get(row.parentReference)?.key;
  if (!parentMatches(row, issue, taskKey, epicLinkField)) counts.invalidParents += 1;
  if (row.type === "Bug") inspectBug(row, issue, taskKey, epicLinkField, counts);
}

function structureRule(type) {
  return type === "Sub-task" ? STRUCTURE_RULES.Task : STRUCTURE_RULES[type];
}

function parentMatches(row, issue, taskKey, epicLinkField) {
  if (row.type === "Sub-task") return taskKey !== undefined && issue.fields.parent?.key === taskKey;
  return issue.fields[epicLinkField] === row.epicKey;
}

function inspectBug(row, issue, taskKey, epicLinkField, counts) {
  const bug = gradeBug({
    bugs: { credited: [issue], duplicates: [] },
    epicKeys: new Set([row.epicKey]),
    taskKeys: new Set(taskKey === undefined ? [] : [taskKey]),
    epicLinkField,
  });
  if (!bug.created) counts.invalidRequired += 1;
  if (!bug.link) counts.invalidLinks += 1;
}

function inspectHierarchy(plan, issues, expected, epicLinkField, requiredFieldsByType) {
  const counts = emptyCounts(plan, expected);
  if (!Array.isArray(issues)) throw new TypeError("hierarchy-read-invalid");
  const byReference = identityIndex(plan, issues, expected, counts);
  for (const row of expected)
    inspectChild(
      row,
      byReference.get(row.reference),
      byReference,
      epicLinkField,
      requiredFieldsByType,
      counts,
    );
  const invalid = Object.entries(counts)
    .filter(([name]) => name.startsWith("invalid"))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    ok: counts.missing + counts.duplicates + counts.unexpected + invalid === 0,
    counts,
    byReference,
  };
}

/** Strict native oracle: no model answer, receipt or tool response substitutes for a Jira issue. */
export function gradeHierarchyBulk({ plan, issues, epicLinkField, requiredFieldsByType = {} }) {
  const { ok, counts } = inspectHierarchy(
    plan,
    issues,
    plan.children,
    epicLinkField,
    requiredFieldsByType,
  );
  if (!metadataReady({ fieldIds: { epicLink: epicLinkField }, requiredFieldsByType }))
    counts.invalidMetadata += 1;
  return { ok: ok && counts.invalidMetadata === 0, counts };
}

function metadataReady(truth) {
  return (
    /^customfield_[1-9]\d*$/.test(truth?.fieldIds?.epicLink ?? "") &&
    TYPES.every((type) => {
      const fields = truth.requiredFieldsByType?.[type];
      return (
        Array.isArray(fields) &&
        fields.includes("summary") &&
        fields.every((name) => typeof name === "string" && name !== "")
      );
    })
  );
}

function contextReady(ctx) {
  const ports = [
    ctx.turn,
    ctx.search,
    ctx.signal?.throwIfAborted,
    ctx.intent?.update,
    ctx.intent?.record,
  ];
  return (
    projectValid(ctx.projectKey) &&
    typeof ctx.sessionDir === "string" &&
    typeof ctx.chat?.id === "string" &&
    ports.every((port) => typeof port === "function")
  );
}

function batchesOf(plan) {
  return TYPES.flatMap((type) => {
    const rows = plan.children.filter((row) => row.type === type);
    return Array.from({ length: Math.ceil(rows.length / BATCH_SIZE) }, (_, index) =>
      rows.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
    );
  });
}

function promptFor(plan, rows, byReference) {
  const instructions = rows.map((row) => ({
    requirementId: row.requirementId,
    summary: row.summary,
    issueType: row.type,
    epicKey: row.epicKey,
    ...(row.type === "Sub-task"
      ? { parentTaskKey: byReference.get(row.parentReference)?.key }
      : {}),
    ...(row.type === "Bug" ? { relatesTaskKey: byReference.get(row.parentReference)?.key } : {}),
    descriptionSections: structureRule(row.type).sections,
    source: row.source,
  }));
  return (
    `Erstelle im Jira-Projekt ${plan.projectKey} genau die folgenden ${rows.length} Vorgänge ` +
    "über die vorhandenen Jira-Chat-Werkzeuge und den geltenden Freigabepfad. " +
    "Lies die zugehörigen Anforderungen aus dem bereits bereitgestellten Lastenheft. " +
    "Übernimm jede Zusammenfassung exakt. Fülle alle aktuell erforderlichen nativen Create-Felder " +
    "und jeden genannten Beschreibungsabschnitt mit fachlichem Inhalt aus der genannten Quelle. " +
    "Task und Bug gehören über das native Epic-Link-Feld zum genannten Epic. Ein Sub-task " +
    "gehört ausschließlich über parent zur exakt genannten Task, niemals direkt zu einem Epic. " +
    "Setze für jeden Bug eine aktuell erlaubte Priorität und eine Relates-Verknüpfung zur exakt " +
    "genannten Task. Erstelle keine weiteren Vorgänge und keine fehlenden Eltern. Lehnt Keiko " +
    "einen Entwurf vor dem Schreiben mit einem Korrekturhinweis ab, folge dem Hinweis und sende " +
    "ihn erneut. Bei einem fehlgeschlagenen oder unklaren Schreibergebnis stoppe, ohne einen " +
    "Create-Aufruf zu wiederholen.\n" +
    JSON.stringify(instructions)
  );
}

async function checkpoint(ctx, value) {
  await ctx.intent.update({ hierarchyBulk: value });
  await ctx.onState?.({ step: STEP, phase: value.phase, batchesCompleted: value.next });
  return value;
}

function publicResult(status, reason, counts = {}, evidenceFile) {
  return {
    step: STEP,
    status,
    detail: `${reason}; epics=${counts.epics ?? 0}; tasks=${counts.tasks ?? 0}; bugs=${counts.bugs ?? 0}; subtasks=${counts.subtasks ?? 0}`,
    counts,
    ...(evidenceFile === undefined ? {} : { evidenceFile }),
  };
}

async function finish(ctx, status, reason, counts = {}, digest) {
  const evidenceFile = join(ctx.sessionDir, "hierarchy-bulk.json");
  const result = publicResult(status, reason, counts, evidenceFile);
  privateJson(evidenceFile, { schemaVersion: 1, ...result, ...(digest ? { digest } : {}) });
  await ctx.intent.record(STEP, result);
  return result;
}

async function freshIssues(ctx) {
  ctx.signal.throwIfAborted();
  return ctx.search(`project = "${ctx.projectKey}" ORDER BY id ASC`, "*all");
}

function prefixGrade(ctx, plan, batches, next, issues) {
  return inspectHierarchy(
    plan,
    issues,
    batches.slice(0, next).flat(),
    ctx.truth.fieldIds.epicLink,
    ctx.truth.requiredFieldsByType,
  );
}

function savedCheckpoint(ctx, plan, batches) {
  const saved = ctx.intent.state?.hierarchyBulk;
  if (saved === undefined) return { phase: "ready", next: 0, digest: plan.digest };
  if (
    saved.digest !== plan.digest ||
    !["ready", "writing", "complete"].includes(saved.phase) ||
    !checkpointPositionValid(saved, batches.length)
  )
    throw new TypeError("hierarchy-checkpoint-mismatch");
  return saved;
}

function checkpointPositionValid(saved, size) {
  return (
    Number.isInteger(saved.next) &&
    saved.next >= 0 &&
    saved.next <= size &&
    !(saved.phase === "writing" && saved.next === size) &&
    !(saved.phase === "complete" && saved.next !== size)
  );
}

async function reconcile(ctx, plan, batches, saved, issues) {
  const next = saved.next + (saved.phase === "writing" ? 1 : 0);
  const observed = prefixGrade(ctx, plan, batches, next, issues);
  if (!observed.ok) return { saved, observed, ready: false };
  if (saved.phase === "writing") saved = await checkpoint(ctx, { ...saved, phase: "ready", next });
  return { saved, observed, ready: true };
}

function turnOptionsFor(ctx, type) {
  const operations = ["jira.draft", "jira.create"];
  if (type === "Bug") operations.push("jira.create-issue-link");
  return { operations, ...ctx.turnOptions };
}

async function executeBatch(ctx, plan, rows, index, batches, observed, faults) {
  ctx.signal.throwIfAborted();
  const progress = batches.slice(0, index).flat().length / plan.children.length;
  const event = { step: STEP, batch: index + 1, count: rows.length, type: rows[0].type, progress };
  await faults?.maybeInject(ctx, progress);
  await ctx.checkLicense?.();
  await ctx.beforeBatch?.(event);
  await checkpoint(ctx, { phase: "writing", next: index, digest: plan.digest });
  await ctx.turn(
    ctx.chat,
    promptFor(plan, rows, observed.byReference),
    turnOptionsFor(ctx, rows[0].type),
  );
  const fresh = prefixGrade(ctx, plan, batches, index + 1, await freshIssues(ctx));
  if (!fresh.ok) return fresh;
  await checkpoint(ctx, { phase: "ready", next: index + 1, digest: plan.digest });
  await ctx.afterBatch?.({
    ...event,
    progress: batches.slice(0, index + 1).flat().length / plan.children.length,
  });
  return fresh;
}

async function runBatches(ctx, plan, batches, start, observed, faults) {
  for (let index = start; index < batches.length; index += 1) {
    observed = await executeBatch(ctx, plan, batches[index], index, batches, observed, faults);
    if (!observed.ok)
      return finish(ctx, "red", "native-oracle-refused", observed.counts, plan.digest);
  }
  await faults?.maybeInject(ctx, 1);
  const grade = gradeHierarchyBulk({
    plan,
    issues: await freshIssues(ctx),
    epicLinkField: ctx.truth.fieldIds.epicLink,
    requiredFieldsByType: ctx.truth.requiredFieldsByType,
  });
  if (grade.ok)
    await checkpoint(ctx, { phase: "complete", next: batches.length, digest: plan.digest });
  return finish(ctx, grade.ok ? "green" : "red", "native-oracle", grade.counts, plan.digest);
}

async function runPrepared(ctx, faults) {
  const manifest = loadGoldenManifest();
  if (
    manifest.requirementCount !== GOLDEN_REQUIREMENT_COUNT ||
    manifest.requirements?.length !== GOLDEN_REQUIREMENT_COUNT
  )
    throw new TypeError("hierarchy-manifest-invalid");
  const issues = await freshIssues(ctx);
  const plan = hierarchyBulkPlan({
    projectKey: ctx.projectKey,
    requirements: manifest.requirements,
    epics: issues.filter((issue) => issue.fields?.issuetype?.name === "Epic"),
  });
  const batches = batchesOf(plan);
  const saved = savedCheckpoint(ctx, plan, batches);
  const resumed = await reconcile(ctx, plan, batches, saved, issues);
  if (!resumed.ready)
    return finish(
      ctx,
      "unverified",
      "unreconciled-hierarchy",
      resumed.observed.counts,
      plan.digest,
    );
  if (resumed.saved.phase === "complete")
    return finish(ctx, "green", "native-oracle", resumed.observed.counts, plan.digest);
  return runBatches(ctx, plan, batches, resumed.saved.next, resumed.observed, faults);
}

/** Browser-backed execution, durable intent checkpoints and an independent complete-project oracle. */
export async function runHierarchyBulk(ctx, { faults } = {}) {
  if (!contextReady(ctx)) return publicResult("unverified", "context-unavailable");
  if (!metadataReady(ctx.truth)) return finish(ctx, "unverified", "create-metadata-unavailable");
  try {
    return await runPrepared(ctx, faults);
  } catch {
    // A pending write remains pending: neither a lost response nor a restart authorizes replay.
    return finish(ctx, "unverified", "interrupted-or-invalid-evidence");
  }
}
