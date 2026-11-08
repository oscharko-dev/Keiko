import { compareStrings } from "../../lib/compare-strings.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { nativePages, projectAgileRead } from "./project-agile-oracles.mjs";
import {
  JourneyStepFailure,
  issueRead as sharedIssueRead,
  stepOutcome,
} from "./browser-journey-step.mjs";

export function requireRoleFact(condition, code = "native-state-mismatch", stage = "readback") {
  if (condition) return;
  throw new JourneyStepFailure(code, stage);
}
export const same = (actual, expected) => isDeepStrictEqual(actual, expected);
export function nativeId(value) {
  const valid =
    typeof value === "number"
      ? Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
  requireRoleFact(valid);
  return String(value);
}
export function stateEntity(environment, name) {
  const value = environment.group.state?.[name];
  requireRoleFact(value !== undefined && value !== null);
  return { ...value, id: nativeId(value.id) };
}
export function rememberEntity(environment, name, value) {
  environment.group.state ??= {};
  environment.group.state[name] = {
    id: nativeId(value.id),
    ...(value.key ? { key: value.key } : {}),
  };
}
export async function roleRead(environment, path) {
  try {
    return environment.read
      ? await environment.read(path)
      : await projectAgileRead(environment.context.session, path);
  } catch {
    requireRoleFact(false, "native-read-unavailable");
  }
}
export async function roleReadResult(environment, path) {
  try {
    if (environment.readResult) return await environment.readResult(path);
    const session = environment.context.session;
    return await labRequest(
      session,
      "GET",
      path,
      session.oracleAuthorization ?? basicAuth(session, "admin"),
    );
  } catch {
    requireRoleFact(false, "native-read-unavailable");
  }
}
export async function rolePages(environment, path, field) {
  try {
    return await nativePages((target) => roleRead(environment, target), path, field);
  } catch {
    requireRoleFact(false, "native-read-unavailable");
  }
}
export const quotedJql = (value) =>
  `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
export function projectJql(environment, suffix = "") {
  return `project = ${quotedJql(environment.fixture.project.key)}${suffix} ORDER BY key`;
}
export async function roleSearch(environment, jql) {
  return rolePages(
    environment,
    `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=*all`,
    "issues",
  );
}
export const issueRead = (environment, key) =>
  sharedIssueRead(environment.context ?? {}, key, (_session, path) => roleRead(environment, path));
export const sprintRead = (environment, id) =>
  roleRead(environment, `/rest/agile/1.0/sprint/${id}`);
export const sprintIssues = (environment, id) =>
  rolePages(environment, `/rest/agile/1.0/sprint/${id}/issue`, "issues");
export const boardSprints = (environment) =>
  rolePages(environment, `/rest/agile/1.0/board/${environment.fixture.board.id}/sprint`, "values");
export const projectVersions = (environment) =>
  roleRead(environment, `/rest/api/2/project/${environment.fixture.project.id}/versions`);
export const projectComponents = (environment) =>
  roleRead(environment, `/rest/api/2/project/${environment.fixture.project.id}/components`);
export function exactKeys(actual, expected) {
  const keys = actual.map((value) => (typeof value === "string" ? value : value.key));
  requireRoleFact(keys.every((key) => typeof key === "string"));
  requireRoleFact(
    new Set(keys).size === keys.length &&
      same([...keys].sort(compareStrings), [...expected].sort(compareStrings)),
  );
  return keys;
}
export function oneNewNative(before, after, matches) {
  requireRoleFact(Array.isArray(before) && Array.isArray(after));
  const previous = new Set(before.map((item) => nativeId(item.id)));
  requireRoleFact(
    before.every((item) => after.some((next) => nativeId(next.id) === nativeId(item.id))),
  );
  const added = after.filter((item) => !previous.has(nativeId(item.id)));
  requireRoleFact(added.length === 1 && matches(added[0]));
  return added[0];
}
export function issueIdentity(issue, selected, project) {
  requireRoleFact(nativeId(issue.id) === nativeId(selected.id) && issue.key === selected.key);
  requireRoleFact(issue.fields?.project?.key === project.key);
}
export function sprintProjection(value) {
  return Object.fromEntries(
    ["id", "originBoardId", "name", "goal", "state", "startDate", "endDate"].map((key) => [
      key,
      key === "id" || key === "originBoardId" ? nativeId(value[key]) : value[key],
    ]),
  );
}
export function exactSprint(value, expected) {
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = value[key];
    requireRoleFact(sprintFieldMatches(key, actual, wanted));
  }
}
function sprintFieldMatches(key, actual, wanted) {
  if (key.endsWith("Date")) return Date.parse(actual) === Date.parse(wanted);
  if (key === "id" || key === "originBoardId") return nativeId(actual) === nativeId(wanted);
  return same(actual, wanted);
}
export function exactBody(body, expected) {
  return same(body, expected);
}
export function editBody(body, fields) {
  return same(body, { fields, update: {} });
}
export function effectProof(turn, operations, facts = {}, denied = false) {
  return { ...stepOutcome(turn, { operations, denied }), ...facts };
}
const keyDigest = (keys) =>
  createHash("sha256")
    .update([...keys].sort(compareStrings).join("\n"))
    .digest("hex");
function answerKeys(answer) {
  const visible = answer.replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1");
  return [...new Set(visible.match(/\b[A-Z][A-Z0-9_]*-[1-9][0-9]*\b/gu) ?? [])].sort(
    compareStrings,
  );
}
function exactAnswer(turn, keys, numbers) {
  requireRoleFact(
    typeof turn.answer === "string" && turn.answer.trim().length > 0,
    "answer-missing",
    "answer",
  );
  requireRoleFact(
    same(answerKeys(turn.answer), [...keys].sort(compareStrings)),
    "answer-keys-mismatch",
    "answer",
  );
  const text = turn.answer.replaceAll(/[*`]/gu, "");
  for (const [label, expected] of Object.entries(numbers)) {
    const escaped = label.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const values = [
      ...text.matchAll(
        new RegExp(
          `(?:^|\\n)\\s*(?:[-•]\\s*)?${escaped}\\s*:\\s*([0-9]+(?:[.,][0-9]+)?)\\b`,
          "giu",
        ),
      ),
    ];
    requireRoleFact(
      values.length === 1 && Number(values[0][1].replace(",", ".")) === expected,
      "answer-numbers-mismatch",
      "answer",
    );
  }
}
export function readProof(turn, operations, issues, numbers) {
  const keys = issues.map((issue) => issue.key);
  exactAnswer(turn, keys, numbers);
  return {
    ...stepOutcome(turn, { operations, readOnly: true }),
    matchedKeys: keys.length,
    keysHash: keyDigest(keys),
    metrics: numbers,
  };
}
export function pointsTotal(environment, issues) {
  const field = environment.fixture.storyPointsField.id;
  return issues.reduce((sum, issue) => {
    const value = issue.fields?.[field];
    requireRoleFact(typeof value === "number" && Number.isFinite(value) && value >= 0);
    return sum + value;
  }, 0);
}
export function chosenTransition(body, done) {
  requireRoleFact(Array.isArray(body.transitions));
  const selected = body.transitions.filter((item) =>
    done
      ? item.to?.statusCategory?.key === "done"
      : item.to?.statusCategory?.key === "indeterminate",
  );
  requireRoleFact(selected.length === 1);
  return selected[0];
}
export function definition(meta, prompt, wire, verify, denied = false) {
  return { ...meta, name: meta.id, prompt, wire, readable: true, denied, verify };
}
