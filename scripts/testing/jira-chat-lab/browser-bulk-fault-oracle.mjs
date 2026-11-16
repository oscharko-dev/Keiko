// Native Jira facts only. No tool result or model answer substitutes for this observation.
import { createHash } from "node:crypto";
import { nativePages } from "./project-agile-oracles.mjs";

const MAX_RECORDS = 10_000;
const ISSUE_FIELDS = "summary,project,status,parent,updated";
const REFERENCE_ARRAYS = new Set([
  "keys",
  "issueKeys",
  "memberKeys",
  "createdKeys",
  "movedKeys",
  "populationKeys",
]);
// A checkpoint grades its own scope: the unit it interrupted records those keys and cursors. Whole
// intent walks also visited every earlier step's issue copies, which pass 100,000 nodes with a
// project of about 700 issues (the progress simulation alone keeps several full copies of each).
const SCOPE_SECTIONS = {
  "bulk-epics": ["bulk-epics", "bulkEpics"],
  hierarchy: ["hierarchy", "hierarchyBulk"],
  progress: ["progress", "progressSimulation", "sprintBulk", "progress-simulation"],
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireFact(condition) {
  if (!condition) throw new TypeError("Native fault evidence is incomplete");
}
function nativeId(value) {
  if (typeof value === "number") requireFact(Number.isSafeInteger(value) && value > 0);
  else requireFact(typeof value === "string" && /^[1-9][0-9]*$/u.test(value));
  return String(value);
}
function issueKey(value, projectKey) {
  return typeof value === "string" && new RegExp(`^${projectKey}-[1-9][0-9]*$`, "u").test(value);
}
function nativeRecord(issue, projectKey) {
  requireFact(issueKey(issue?.key, projectKey));
  requireFact(typeof issue.fields?.summary === "string" && issue.fields.summary.length > 0);
  if (issue.fields.project !== undefined) requireFact(issue.fields.project.key === projectKey);
  return {
    key: issue.key,
    id: nativeId(issue.id),
    summaryDigest: digest(issue.fields.summary),
    stateDigest: digest([issue.fields.status, issue.fields.parent, issue.fields.updated]),
  };
}
function nativeRecords(issues, projectKey) {
  requireFact(Array.isArray(issues) && issues.length <= MAX_RECORDS);
  const rows = issues.map((issue) => nativeRecord(issue, projectKey));
  requireFact(new Set(rows.map((row) => row.key)).size === rows.length);
  requireFact(new Set(rows.map((row) => row.id)).size === rows.length);
  return rows;
}
function reference(state, value, id, projectKey) {
  if (!issueKey(value, projectKey)) return;
  const selected = id === undefined ? undefined : nativeId(id);
  const prior = state.references.get(value);
  if (prior?.id !== undefined && selected !== undefined) requireFact(prior.id === selected);
  state.references.set(value, {
    key: value,
    ...(selected === undefined ? prior : { id: selected }),
  });
}
function walkIntent(value, state, projectKey, field = "", depth = 0) {
  state.visited += 1;
  requireFact(state.visited <= 100_000 && depth <= 32);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (REFERENCE_ARRAYS.has(field))
      value.forEach((key) => reference(state, key, undefined, projectKey));
    value.forEach((item) => walkIntent(item, state, projectKey, field, depth + 1));
    return;
  }
  reference(state, value.key, value.id, projectKey);
  reference(state, value.issueKey, value.issueId, projectKey);
  for (const [name, item] of Object.entries(value)) walkField(name, item, state, projectKey, depth);
}
function walkField(name, item, state, projectKey, depth) {
  if (name === "faults") return;
  if (name === "sprintId" && item !== undefined) state.sprints.add(nativeId(item));
  if (name === "sprint" && item?.id !== undefined) state.sprints.add(nativeId(item.id));
  walkIntent(item, state, projectKey, name, depth + 1);
}
/** Native issue records already carry the full issue; the simulation's intent needs only its keys. */
function sectionFacts(name, value) {
  if (name !== "progress-simulation" || !value || typeof value !== "object") return value;
  return {
    populationKeys: value.populationKeys,
    completed: Array.isArray(value.completed)
      ? value.completed.map((unit) => ({ key: unit?.key }))
      : undefined,
  };
}
function scopeFacts(data, scope) {
  return Object.fromEntries(
    SCOPE_SECTIONS[scope]
      .filter((name) => data[name] !== undefined)
      .map((name) => [name, sectionFacts(name, data[name])]),
  );
}
function intentPositions(data, scope) {
  const positions = {};
  for (const name of SCOPE_SECTIONS[scope]) {
    const unit = data[name];
    for (const field of ["completedBatches", "next", "completedUnits"]) {
      const value = unit?.[field];
      if (value === undefined) continue;
      requireFact(Number.isSafeInteger(value) && value >= 0);
      positions[`${name}:${field}`] = value;
    }
  }
  return positions;
}
function intentFacts(ctx, scope) {
  const data = ctx.intent.state;
  const state = { references: new Map(), sprints: new Set(), visited: 0 };
  walkIntent(scopeFacts(data, scope), state, ctx.projectKey);
  const positions = intentPositions(data, scope);
  requireFact(state.references.size <= MAX_RECORDS && state.sprints.size <= 50);
  return { references: [...state.references.values()], sprintIds: [...state.sprints], positions };
}
async function sprintMembership(ctx, ids) {
  return Promise.all(
    ids.map(async (id) => {
      ctx.signal.throwIfAborted();
      const rows = await nativePages(
        ctx.read,
        `/rest/agile/1.0/sprint/${id}/issue?fields=${ISSUE_FIELDS}`,
        "issues",
      );
      return { id, keys: nativeRecords(rows, ctx.projectKey).map((row) => row.key) };
    }),
  );
}
/** The search port owns complete native JQL paging; the existing Agile reader owns sprint paging. */
export async function observeFaultCheckpoint(ctx, scope) {
  ctx.signal.throwIfAborted();
  requireFact(typeof ctx.search === "function" && typeof ctx.read === "function");
  const facts = intentFacts(ctx, scope);
  const project = await ctx.read(`/rest/api/2/project/${ctx.projectKey}`);
  requireFact(project?.key === ctx.projectKey);
  const records = nativeRecords(
    await ctx.search(`project = "${ctx.projectKey}" ORDER BY id ASC`, ISSUE_FIELDS),
    ctx.projectKey,
  );
  const sprints = scope === "progress" ? await sprintMembership(ctx, facts.sprintIds) : [];
  ctx.signal.throwIfAborted();
  return {
    schemaVersion: 1,
    scope,
    projectKey: ctx.projectKey,
    records,
    references: facts.references,
    sprints,
    positions: facts.positions,
  };
}
function recordMissing(expected, actual) {
  return (
    !actual ||
    (expected.id !== undefined && actual.id !== expected.id) ||
    (expected.summaryDigest !== undefined && actual.summaryDigest !== expected.summaryDigest)
  );
}
function lostKeys(before, after) {
  const rows = new Map(after.records.map((row) => [row.key, row]));
  const lost = new Set();
  for (const expected of [...before.records, ...before.references, ...after.references]) {
    const actual = rows.get(expected.key);
    if (recordMissing(expected, actual)) lost.add(expected.key);
  }
  for (const sprint of before.sprints) {
    const members = new Set(after.sprints.find((item) => item.id === sprint.id)?.keys ?? []);
    for (const key of sprint.keys) if (!members.has(key)) lost.add(key);
  }
  return [...lost];
}
function checkpointRetained(before, after) {
  const references = new Set(after.references.map((row) => row.key));
  return (
    before.references.every((row) => references.has(row.key)) &&
    Object.entries(before.positions).every(([key, value]) => after.positions[key] >= value)
  );
}
function cursorAdvanced(before, after) {
  const entries = Object.entries(before.positions);
  return entries.length === 0 || entries.some(([key, value]) => after.positions[key] > value);
}
function nativeAdvanced(before, after) {
  const rows = new Map(before.records.map((row) => [row.key, row]));
  if (before.scope !== "progress") return after.records.some((row) => !rows.has(row.key));
  if (
    after.records.some(
      (row) => !rows.has(row.key) || rows.get(row.key).stateDigest !== row.stateDigest,
    )
  )
    return true;
  return after.sprints.some((sprint) => {
    const prior = new Set(before.sprints.find((item) => item.id === sprint.id)?.keys ?? []);
    return sprint.keys.some((key) => !prior.has(key));
  });
}
/** A numeric progress argument alone is never native continuation evidence. */
export function gradeFaultCheckpoint(before, after, { progress01, checkpointProgress }) {
  requireFact(before?.schemaVersion === 1 && after?.schemaVersion === 1);
  requireFact(before.scope === after.scope && before.projectKey === after.projectKey);
  const duplicates =
    after.records.length - new Set(after.records.map((row) => row.summaryDigest)).size;
  const missing = lostKeys(before, after);
  const retained = checkpointRetained(before, after);
  const advanced = before.scope === "progress" || cursorAdvanced(before, after);
  return {
    duplicates,
    lost: missing.length,
    lostKeys: missing,
    retained,
    continued:
      retained && advanced && progress01 > checkpointProgress && nativeAdvanced(before, after),
  };
}
