// W7 changes existing native issues, retaining the orchestrator's single durable intent owner.
// A pending effect is reconciled with reads on restart; it is never automatically repeated.
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_TEMPLATE_SYSTEM_FIELDS,
  resolveJiraTemplateFieldIds,
} from "@oscharko-dev/keiko-connectors";
import { basicAuth, checked, labRequest } from "../lab-client.mjs";
import { discoverReadableEstimate } from "./estimate-field.mjs";
import { pagedJql } from "./journeys.mjs";
import { fieldIds, inBatches, moveTo, updateFields } from "./seed-projects.mjs";
import { listTemplates } from "./templates.mjs";

const STEP = "progress-simulation";
const STATUSES = ["Done", "In Progress", "To Do"];
const BASE_FIELDS = ["project", "issuetype", "status", "labels", "parent"];
const PRIVATE_FIELDS = ["summary", "description", "issuelinks"];
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const text = (value) => typeof value === "string" && value.length > 0;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

async function browserJson(ctx, path) {
  ctx.signal.throwIfAborted();
  const url = new URL(path, ctx.page.url());
  const result = await ctx.page.request.get(url.href);
  if (!result.ok()) throw new TypeError("Template observation unavailable");
  const body = await result.json();
  ctx.signal.throwIfAborted();
  return body;
}

function boundTemplateRules(ctx, listed, body) {
  const parsed = parseJiraIssueTemplate(body);
  if (
    !parsed.ok ||
    parsed.template.project !== ctx.projectKey ||
    parsed.template.issueType !== listed.issueType ||
    !parsed.template.activations.some(
      (activation) => activation.kind === "create" || activation.kind === "edit",
    )
  )
    throw new TypeError("Template binding changed");
  return parsed.template;
}

async function readTemplate(ctx, listed) {
  if (!text(listed.id) || !Number.isSafeInteger(listed.revision) || listed.revision < 1)
    throw new TypeError("Template identity unavailable");
  const path = `/api/skills/${encodeURIComponent(listed.id)}?revision=${listed.revision}`;
  const { skill } = await browserJson(ctx, path);
  if (
    skill?.id !== listed.id ||
    skill.revision !== listed.revision ||
    typeof skill.body !== "string"
  )
    throw new TypeError("Template revision changed");
  const rules = boundTemplateRules(ctx, listed, skill.body);
  return { id: listed.id, revision: listed.revision, sha256: hash(skill.body), rules };
}

/** Same authenticated browser read owner as the report; no body or credential is retained. */
export async function readInstalledTemplateScope(ctx) {
  const listed = await listTemplates((_name, path) => browserJson(ctx, path));
  if (!Array.isArray(listed)) throw new TypeError("Template listing unavailable");
  if (listed.some((item) => item?.valid !== true))
    throw new TypeError("Formal template is unreadable");
  const selected = listed.filter(
    (item) =>
      item.valid === true &&
      item.project === ctx.projectKey &&
      Array.isArray(item.activations) &&
      item.activations.some((activation) => activation === "create" || activation === "edit"),
  );
  const templates = [];
  await inBatches(selected, 1, async (item) => {
    templates.push(await readTemplate(ctx, item));
  });
  const parentForTypes = {};
  for (const { rules } of templates) {
    if (rules.parent.field === undefined) continue;
    const previous = Object.hasOwn(parentForTypes, rules.issueType)
      ? parentForTypes[rules.issueType]
      : undefined;
    if (previous !== undefined && previous !== rules.parent.field)
      throw new TypeError("Conflicting template parent fields");
    if (previous === undefined)
      Object.defineProperty(parentForTypes, rules.issueType, {
        value: rules.parent.field,
        enumerable: true,
      });
  }
  return {
    project: ctx.projectKey,
    issueTypes: [...new Set(templates.map((item) => item.rules.issueType))],
    labelsForTypes: [
      ...new Set(
        templates
          .filter((item) => item.rules.labels.required.includes("anforderung"))
          .map((item) => item.rules.issueType),
      ),
    ],
    parentForTypes,
    templates,
  };
}

/**
 * The fields a template reference can name, as the product resolves them: Jira's system fields
 * and the native field list, one entry per id. Data Center's `GET field` omits `parent`.
 */
export function templateFieldCatalog(catalog) {
  const fields = new Map();
  for (const field of [...JIRA_TEMPLATE_SYSTEM_FIELDS, ...catalog])
    fields.set(field.id, { id: field.id, name: field.name });
  return [...fields.values()];
}

/** Field IDs for the one independent JQL reader. Unknown required-field names fail closed. */
export function progressEvidenceFields({ fieldIds: ids, estimate, templateScope, fieldCatalog }) {
  const fields = new Set([...BASE_FIELDS, ...PRIVATE_FIELDS]);
  if (ids.epicLink !== undefined) fields.add(ids.epicLink);
  if (estimate !== undefined) fields.add(estimate.fieldId);
  for (const { rules } of templateScope.templates) {
    const references = [...rules.requiredFields];
    if (rules.parent.field !== undefined) references.push(rules.parent.field);
    for (const reference of references) {
      const resolved = resolveJiraTemplateFieldIds(reference, fieldCatalog);
      if (resolved.length !== 1) throw new TypeError("Template field binding unavailable");
      fields.add(resolved[0]);
    }
  }
  return [...fields];
}

function nativeType(type) {
  if (!text(type?.id) || !text(type.name) || typeof type.subtask !== "boolean")
    throw new TypeError("Native issue type unavailable");
  return { id: type.id, name: type.name, subtask: type.subtask };
}

function nativeStatus(status) {
  if (!text(status?.id) || !text(status.name) || !text(status.statusCategory?.key))
    throw new TypeError("Native issue status unavailable");
  return { id: status.id, name: status.name, statusCategory: { key: status.statusCategory.key } };
}

function identityFields(issue) {
  const fields = issue.fields;
  if (
    !text(issue.id) ||
    !text(issue.key) ||
    !record(fields) ||
    !text(fields.project?.id) ||
    !text(fields.project?.key)
  )
    throw new TypeError("Native issue identity unavailable");
  if (!Array.isArray(fields.labels) || fields.labels.some((label) => typeof label !== "string"))
    throw new TypeError("Native labels unavailable");
  return {
    project: { id: fields.project.id, key: fields.project.key },
    issuetype: nativeType(fields.issuetype),
    status: nativeStatus(fields.status),
    labels: [...fields.labels],
  };
}

function retainedField(fields, target, id, kind) {
  if (id === undefined || !Object.hasOwn(fields, id)) return;
  const value = fields[id];
  if (
    value !== null &&
    (kind === "number" ? typeof value !== "number" || !Number.isFinite(value) : !text(value))
  )
    throw new TypeError("Native field value unavailable");
  target[id] = value;
}

function retainParent(issue, fields, configuration) {
  const parent = issue.fields.parent;
  if (fields.issuetype.subtask && (parent === null || parent === undefined))
    throw new TypeError("Native subtask parent unavailable");
  if (
    requiredParent(configuration, issue) &&
    !Object.hasOwn(issue.fields, configuration.fieldIds.epicLink)
  )
    throw new TypeError("Requested native parent field unavailable");
  if (parent === null) fields.parent = null;
  else if (parent !== undefined) {
    if (!text(parent.id) || !text(parent.key))
      throw new TypeError("Native parent identity unavailable");
    fields.parent = { id: parent.id, key: parent.key };
  }
}

/** Persist only needed wire facts; other requested fields contribute digests, never their bodies. */
export function projectProgressNativeIssue(issue, configuration) {
  const fields = identityFields(issue);
  retainParent(issue, fields, configuration);
  retainedField(issue.fields, fields, configuration.fieldIds.epicLink, "string");
  retainedField(issue.fields, fields, configuration.estimate?.fieldId, "number");
  const retained = new Set([
    ...BASE_FIELDS,
    configuration.fieldIds.epicLink,
    configuration.estimate?.fieldId,
  ]);
  const fieldDigests = Object.fromEntries(
    progressEvidenceFields(configuration)
      .filter((id) => !retained.has(id))
      .map((id) => {
        const present = Object.hasOwn(issue.fields, id);
        return [
          id,
          hash(JSON.stringify({ present, ...(present ? { value: issue.fields[id] } : {}) })),
        ];
      }),
  );
  return { id: issue.id, key: issue.key, fields, fieldDigests };
}

function selectedType(selectors, issue) {
  const { id, name } = issue.fields.issuetype;
  return selectors.some(
    (selector) => selector === id || selector.toLowerCase() === name.toLowerCase(),
  );
}

function requiredParent(configuration, issue) {
  const entries = Object.entries(configuration.templateScope.parentForTypes).filter(([selector]) =>
    selectedType([selector], issue),
  );
  return entries.some(([, reference]) =>
    resolveJiraTemplateFieldIds(reference, configuration.fieldCatalog).includes(
      configuration.fieldIds.epicLink,
    ),
  );
}

function removeRequiredLabel(configuration, issue, index) {
  return (
    (index + 1) % 7 === 0 &&
    selectedType(configuration.templateScope.labelsForTypes, issue) &&
    issue.fields.labels.includes("anforderung")
  );
}

function removeRequiredParent(configuration, issue, taskOrdinal) {
  return (
    issue.fields.issuetype.name === "Task" &&
    taskOrdinal % 11 === 0 &&
    requiredParent(configuration, issue) &&
    text(issue.fields[configuration.fieldIds.epicLink])
  );
}

function changedFields(configuration, issue, index, taskOrdinal, seedDeviations) {
  if (!seedDeviations || issue.fields.issuetype.subtask) return {};
  return {
    ...(removeRequiredLabel(configuration, issue, index)
      ? { labels: issue.fields.labels.filter((label) => label !== "anforderung") }
      : {}),
    ...(removeRequiredParent(configuration, issue, taskOrdinal)
      ? { [configuration.fieldIds.epicLink]: null }
      : {}),
  };
}

function plannedUnits(configuration, issues, seedDeviations) {
  let taskOrdinal = 0;
  return issues.flatMap((issue, index) => {
    if (issue.fields.issuetype.name === "Task") taskOrdinal += 1;
    const before = projectProgressNativeIssue(issue, configuration);
    const changes = changedFields(configuration, issue, index, taskOrdinal, seedDeviations);
    const units = [];
    if (Object.keys(changes).length > 0) {
      units.push({
        id: `${issue.key}:fields`,
        key: issue.key,
        kind: "fields",
        before: structuredClone(before),
        desired: changes,
      });
      Object.assign(before.fields, changes);
    }
    const desired =
      issue.fields.issuetype.name === "Epic"
        ? issue.fields.status.name
        : STATUSES[index % STATUSES.length];
    if (desired !== issue.fields.status.name)
      units.push({
        id: `${issue.key}:transition`,
        key: issue.key,
        kind: "transition",
        before,
        desired,
      });
    return units;
  });
}

async function nativeConfiguration(ctx, native) {
  const ids = await fieldIds(native, ctx.projectKey);
  const catalog = await checked(
    ctx.session,
    "progress-fields",
    "GET",
    "/rest/api/2/field",
    native.auth,
  );
  if (!Array.isArray(catalog) || catalog.some((field) => !text(field.id) || !text(field.name)))
    throw new TypeError("Native field catalog unavailable");
  const jira = {
    call: (name, method, path, body) => checked(ctx.session, name, method, path, native.auth, body),
    request: (method, path, body) => labRequest(ctx.session, method, path, native.auth, body),
  };
  const estimate = await discoverReadableEstimate(jira, ctx.projectKey);
  return {
    fieldIds: { ...ids, storyPoints: estimate?.unit === "points" ? estimate.fieldId : undefined },
    fieldCatalog: templateFieldCatalog(catalog),
    ...(estimate === undefined ? {} : { estimate }),
    templateScope: await readInstalledTemplateScope(ctx),
  };
}

async function population(ctx, configuration) {
  ctx.signal.throwIfAborted();
  const result = await pagedJql(
    ctx.session,
    `project = ${ctx.projectKey} ORDER BY id ASC`,
    progressEvidenceFields(configuration).join(","),
  );
  ctx.signal.throwIfAborted();
  const projected = result.issues.map((issue) => projectProgressNativeIssue(issue, configuration));
  if (projected.some((issue) => issue.fields.project.key !== ctx.projectKey))
    throw new TypeError("Native population changed project");
  return { raw: result.issues, issues: projected, pages: result.pages };
}

async function readUnit(ctx, native, state, unit) {
  ctx.signal.throwIfAborted();
  const fields = encodeURIComponent(progressEvidenceFields(state).join(","));
  const issue = await checked(
    ctx.session,
    "progress-readback",
    "GET",
    `/rest/api/2/issue/${encodeURIComponent(unit.key)}?fields=${fields}`,
    native.auth,
  );
  ctx.signal.throwIfAborted();
  return projectProgressNativeIssue(issue, state);
}

function matchesDesired(unit, observed) {
  const expected = structuredClone(unit.before);
  if (unit.kind === "fields") Object.assign(expected.fields, unit.desired);
  else {
    if (observed.fields.status.name !== unit.desired) return false;
    expected.fields.status = observed.fields.status;
  }
  return equal(expected, observed);
}

function finishUnit(ctx, state, unit, observed) {
  if (!matchesDesired(unit, observed)) throw new TypeError("Native effect remains unconfirmed");
  state.completed.push({ id: unit.id, key: unit.key, kind: unit.kind, observed });
  delete state.pending;
  ctx.intent.record(STEP, state);
}

async function executeUnit(ctx, native, state, unit) {
  const before = await readUnit(ctx, native, state, unit);
  if (!equal(unit.before, before)) throw new TypeError("Native input changed before effect");
  state.pending = unit;
  ctx.intent.record(STEP, state);
  ctx.signal.throwIfAborted();
  if (unit.kind === "fields") await updateFields(native, unit.key, unit.desired);
  else await moveTo(native, unit.key, unit.desired);
  finishUnit(ctx, state, unit, await readUnit(ctx, native, state, unit));
}

function deviationsFor(issue, configuration) {
  if (issue.fields.issuetype.subtask) return [];
  const missingLabel =
    selectedType(configuration.templateScope.labelsForTypes, issue) &&
    !issue.fields.labels.includes("anforderung");
  const missingParent =
    requiredParent(configuration, issue) && !text(issue.fields[configuration.fieldIds.epicLink]);
  return [...(missingLabel ? ["label:anforderung"] : []), ...(missingParent ? ["parent"] : [])];
}

function truthIssue(issue, configuration) {
  const fields = issue.fields;
  const epic = fields[configuration.fieldIds.epicLink];
  const estimateField = configuration.estimate?.fieldId;
  return {
    id: issue.id,
    key: issue.key,
    type: fields.issuetype.name,
    typeId: fields.issuetype.id,
    subtask: fields.issuetype.subtask,
    status: fields.status.name,
    category: fields.status.statusCategory.key,
    labels: [...fields.labels],
    ...(text(epic) ? { epic } : {}),
    ...(fields.parent?.key === undefined ? {} : { parent: fields.parent.key }),
    ...(estimateField !== undefined && Object.hasOwn(fields, estimateField)
      ? { estimate: fields[estimateField] }
      : {}),
    deviations: deviationsFor(issue, configuration),
  };
}

function stepResult(ctx, state, status) {
  const completed = state?.completed?.length ?? 0;
  return {
    step: STEP,
    status,
    detail: `Native units completed: ${completed}; state: ${status}`,
    counts: {
      completed,
      ...(state?.populationKeys === undefined ? {} : { issues: state.populationKeys.length }),
    },
    ...(state === undefined ? {} : { evidenceFile: ctx.intent.path }),
  };
}

function sameScope(left, right) {
  const identities = (scope) =>
    scope.templates.map(({ id, revision, sha256 }) => `${id}:${revision}:${sha256}`).sort();
  return left.project === right.project && equal(identities(left), identities(right));
}

async function completeSimulation(ctx, state) {
  const final = await population(ctx, state);
  const previousKeys = state.populationKeys;
  if (
    !equal(
      previousKeys,
      final.issues.map((issue) => issue.key),
    )
  )
    throw new TypeError("Native population drifted during simulation");
  const expected = new Map(state.initial.map((issue) => [issue.key, issue]));
  for (const unit of state.completed) expected.set(unit.key, unit.observed);
  if (!final.issues.every((issue) => equal(issue, expected.get(issue.key))))
    throw new TypeError("Native facts drifted after completed units");
  if (!sameScope(state.templateScope, await readInstalledTemplateScope(ctx)))
    throw new TypeError("Template scope drifted during simulation");
  state.truth = {
    source: STEP,
    project: ctx.projectKey,
    seedVersion: 2,
    issueCount: final.issues.length,
    templateScope: state.templateScope,
    fieldIds: state.fieldIds,
    fieldCatalog: state.fieldCatalog,
    ...(state.estimate === undefined ? {} : { estimate: state.estimate }),
    issues: final.issues.map((issue) => truthIssue(issue, state)),
    native: { issues: final.issues, pages: final.pages },
  };
  ctx.intent.record(STEP, state);
  return stepResult(ctx, state, "green");
}

async function resumeSimulation(ctx, native, state, seedDeviations) {
  if (
    state.schemaVersion !== 1 ||
    state.project !== ctx.projectKey ||
    state.seedDeviations !== seedDeviations
  )
    throw new TypeError("Simulation intent binding changed");
  if (!sameScope(state.templateScope, await readInstalledTemplateScope(ctx)))
    throw new TypeError("Installed templates changed");
  if (state.pending !== undefined) {
    const unit = state.pending;
    finishUnit(ctx, state, unit, await readUnit(ctx, native, state, unit));
    return stepResult(ctx, state, "unverified");
  }
  if (state.truth !== undefined) {
    const actual = await population(ctx, state);
    if (!equal(actual.issues, state.truth.native.issues))
      throw new TypeError("Completed simulation drifted");
    return stepResult(ctx, state, "green");
  }
  const done = new Set(state.completed.map((unit) => unit.id));
  await inBatches(
    state.plan.filter((unit) => !done.has(unit.id)),
    1,
    (unit) => executeUnit(ctx, native, state, unit),
  );
  return completeSimulation(ctx, state);
}

function admitSimulation(ctx, seedDeviations) {
  ctx.signal.throwIfAborted();
  if (
    !/^[A-Z][A-Z0-9_]*$/u.test(ctx.projectKey) ||
    !text(ctx.intent.path) ||
    typeof seedDeviations !== "boolean"
  )
    throw new TypeError("Simulation context unavailable");
}

/** No project creation, no model-supplied target, and no second persistence/transport owner. */
export async function simulateProgress(ctx, { seedDeviations = true } = {}) {
  let state;
  try {
    admitSimulation(ctx, seedDeviations);
    state = ctx.intent.state[STEP];
    const native = {
      session: ctx.session,
      auth: basicAuth(ctx.session, "admin"),
      signal: ctx.signal,
    };
    if (state === undefined) {
      const configuration = await nativeConfiguration(ctx, native);
      const observed = await population(ctx, configuration);
      state = {
        schemaVersion: 1,
        project: ctx.projectKey,
        seedDeviations,
        ...configuration,
        populationKeys: observed.issues.map((issue) => issue.key),
        initial: observed.issues,
        plan: plannedUnits(configuration, observed.raw, seedDeviations),
        completed: [],
      };
      ctx.intent.record(STEP, state);
    }
    return await resumeSimulation(ctx, native, state, seedDeviations);
  } catch {
    // The private intent retains the exact pending unit. No error body or failed response is logged.
    console.log(
      JSON.stringify({
        operation: "requirements-progress-simulation",
        status: "unverified",
        completed: state?.completed?.length ?? 0,
        pending: state?.pending !== undefined,
      }),
    );
    return stepResult(ctx, state, "unverified");
  }
}
