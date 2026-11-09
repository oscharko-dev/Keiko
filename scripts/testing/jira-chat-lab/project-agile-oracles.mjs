import assert from "node:assert/strict";
import { URL } from "node:url";
import { basicAuth, labRequest, labSessionConnection } from "./lab-client.mjs";
import { JIRA_MANAGED_READ_TOOLS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { sprintIdsOf } from "./requirements/field-correction.mjs";
import { canonicalToolId } from "./requirements/tool-exchanges.mjs";

/** Read-only native oracle. No product receipt, model answer or fixture creation is ground truth. */
export async function projectAgileRead(
  session,
  path,
  authorization = session.oracleAuthorization ?? basicAuth(session, "admin"),
) {
  const result = await labRequest(session, "GET", path, authorization);
  assert.equal(result.status, 200, "Independent native observation must be readable");
  return result.value;
}

function observedId(value) {
  if (typeof value === "number") assert.ok(Number.isSafeInteger(value) && value > 0);
  else assert.ok(typeof value === "string" && /^[1-9][0-9]*$/u.test(value));
  return String(value);
}

export async function projectInventory(session) {
  const values = await projectAgileRead(session, "/rest/api/2/project");
  assert.ok(Array.isArray(values), "Native project array is required; a 404 is not absence proof");
  const keys = values.map((entry) => entry.key);
  assert.ok(keys.every((key) => typeof key === "string"));
  assert.equal(new Set(keys).size, keys.length);
  return values.map(({ id, key, name }) => ({ id: observedId(id), key, name }));
}

/** A changing/partial native page is unavailable proof, never an empty collection. */
export async function nativePages(read, path, field) {
  const collected = [];
  let startAt = 0;
  let total;
  for (let page = 0; page < 100; page += 1) {
    const body = await read(
      `${path}${path.includes("?") ? "&" : "?"}startAt=${startAt}&maxResults=50`,
    );
    assert.equal(body.startAt, startAt);
    assert.ok(Array.isArray(body[field]));
    if (body.total !== undefined) {
      assert.ok(Number.isSafeInteger(body.total) && body.total >= 0);
      total ??= body.total;
      assert.equal(body.total, total);
    }
    collected.push(...body[field]);
    assert.equal(
      new Set(collected.map((item) => observedId(item.id))).size,
      collected.length,
      "Repeated native identities do not prove a complete collection",
    );
    assert.ok(total === undefined || collected.length <= total);
    if (body.isLast === true) {
      if (total !== undefined)
        assert.equal(collected.length, total, "Native last-page flag contradicts total");
      return collected;
    }
    if (collected.length === total) {
      assert.notEqual(body.isLast, false, "Native continuation contradicts the exact total");
      return collected;
    }
    assert.ok(body[field].length > 0, "Native cursor must advance before completion");
    startAt += body[field].length;
  }
  throw new TypeError("Independent native page budget exhausted; no complete-set claim");
}

export function oneNewProject(before, after, expected) {
  assert.equal(before.filter((project) => project.key === expected.key).length, 0);
  const oldIds = new Set(before.map((project) => project.id));
  const added = after.filter((project) => !oldIds.has(project.id));
  unchangedProjects(
    before,
    after.filter((project) => oldIds.has(project.id)),
  );
  assert.equal(added.length, 1, "Exactly one independently observed project was created");
  assert.equal(added[0].key, expected.key);
  assert.equal(added[0].name, expected.name);
  return added[0];
}

export function unchangedProjects(before, after) {
  const normalized = (values) => [...values].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(normalized(after), normalized(before), "Denied actor must create no project");
}

export function exactIssue(issue, expected) {
  assert.equal(issue.fields.project.key, expected.projectKey);
  assert.equal(issue.fields.summary, expected.summary);
  assert.equal(issue.fields.issuetype.name, expected.issueType);
  assert.match(issue.key, new RegExp(`^${expected.projectKey}-[1-9][0-9]*$`, "u"));
  assert.ok(typeof issue.fields.description === "string" && issue.fields.description.length > 0);
  return {
    id: observedId(issue.id),
    key: issue.key,
    typeId: observedId(issue.fields.issuetype.id),
    summary: issue.fields.summary,
  };
}

export function epicRelation(task, epic, fields) {
  const epicFields = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
  );
  const nativeParent = task.fields.parent;
  const linked =
    nativeParent?.key === epic.key ||
    String(nativeParent?.id) === epic.id ||
    epicFields.some((field) => task.fields[field.id] === epic.key);
  assert.ok(linked, "Native Task must belong to the intended Epic");
}

export function exactSprint(sprint, expected) {
  assert.equal(observedId(sprint.id), expected.id);
  assert.equal(observedId(sprint.originBoardId), expected.boardId);
  assert.equal(sprint.name, expected.name);
  assert.equal(sprint.state, expected.state);
  if (expected.state === "active" || expected.state === "closed") {
    assert.ok(Number.isFinite(Date.parse(sprint.startDate)));
    assert.ok(Date.parse(sprint.endDate) > Date.parse(sprint.startDate));
  }
  if (expected.state === "closed") assert.ok(Number.isFinite(Date.parse(sprint.completeDate)));
}

export function exactMembership(issues, expectedKeys) {
  assert.deepEqual(issues.map((issue) => issue.key).sort(), [...expectedKeys].sort());
}

export function completedOperation(turn, operation, outcome = "succeeded") {
  const aliases = turn.exchanges.filter(
    (exchange) => exchange.call.name === operation.replaceAll(/[.-]/gu, "_"),
  );
  assert.equal(aliases.length, 1, "One canonical selected operation, no automatic replay");
  assert.equal(aliases[0].result?.status, "completed");
  assert.equal(aliases[0].result?.data?.outcome, outcome);
  return aliases[0].result.data;
}

export function permissionRefusal(turn) {
  const selected = turn.exchanges.filter(
    (exchange) => exchange.call.name === "jira_create_project",
  );
  assert.equal(selected.length, 1);
  assert.ok(
    selected.some((exchange) => {
      const data = exchange.result?.data;
      return data?.reason === "permission-denied" || data?.failureReason === "permission-denied";
    }),
    "The selected project action must preserve its permission refusal",
  );
  assert.ok(turn.answer.trim().length > 0);
}

const FAILURE_STAGES = new Set(["wire", "approval", "readback", "answer", "presentation", "turn"]);
const FAILURE_CODES = new Set([
  "definition-invalid",
  "operation-not-allowed",
  "approval-count-mismatch",
  "approval-order-mismatch",
  "wire-unexpected-write",
  "wire-origin-mismatch",
  "wire-body-invalid",
  "wire-count-mismatch",
  "wire-status-mismatch",
  "wire-acknowledgement-missing",
  "turn-failed",
  "operation-outcome-missing",
  "operation-outcome-unexpected",
  "permission-refusal-missing",
  "unconfirmed-outcome-promoted",
  "readable-summary-missing",
  "jira-action-generic",
  "readable-view-unavailable",
  "raw-result-visible",
  "readback-failed",
  "answer-mismatch",
  "answer-missing",
  "answer-keys-mismatch",
  "answer-numbers-mismatch",
  "native-read-unavailable",
  "native-state-mismatch",
]);

/** Scorecards carry only closed classifications, never an assertion's native values or cause. */
class JourneyStepFailure extends Error {
  constructor(code, stage, presentationFindings = 0) {
    super("Browser journey qualification failed");
    if (
      !FAILURE_CODES.has(code) ||
      !FAILURE_STAGES.has(stage) ||
      !Number.isSafeInteger(presentationFindings) ||
      presentationFindings < 0
    )
      throw new TypeError("Invalid browser journey failure classification");
    this.name = "JourneyStepFailure";
    this.code = code;
    this.failureCode = code;
    this.stage = stage;
    this.presentationFindings = presentationFindings;
  }
}

function requireJourneyCondition(condition, code, stage, presentationFindings = 0) {
  if (!condition) throw new JourneyStepFailure(code, stage, presentationFindings);
}

function wireSpecifications(specification) {
  const values = Array.isArray(specification) ? [...specification] : [specification];
  if (specification === undefined) return [];
  const methods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  for (const value of values) {
    requireJourneyCondition(
      value !== null && typeof value === "object",
      "definition-invalid",
      "wire",
    );
    requireJourneyCondition(
      methods.has(value.method) && typeof value.admit === "function",
      "definition-invalid",
      "wire",
    );
    requireJourneyCondition(
      typeof value.path === "string" || typeof value.path === "function",
      "definition-invalid",
      "wire",
    );
    requireJourneyCondition(
      value.status === undefined ||
        (Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599),
      "definition-invalid",
      "wire",
    );
  }
  return values;
}

function matchesStep(selected, request, target, body) {
  if (selected === undefined || request.method !== selected.method) return false;
  const pathname = target.pathname;
  const configured = selected.path;
  if (typeof configured !== "function")
    return matchesPath(selected, pathname, target, body, configured);
  const resolved = configured.call(selected);
  if (typeof resolved === "string") return matchesPath(selected, pathname, target, body, resolved);
  return Promise.resolve(resolved).then((path) =>
    matchesPath(selected, pathname, target, body, path),
  );
}

function matchesPath(selected, pathname, target, body, path) {
  if (typeof path !== "string") return false;
  const query = path.indexOf("?");
  const expectedPath = query < 0 ? path : path.slice(0, query);
  if (pathname !== expectedPath) return false;
  const expectedSearch = query < 0 ? "" : path.slice(query);
  if (target.search !== expectedSearch) return false;
  return selected.admit(body);
}

function matchesLegacyStep(selected, request, target, body) {
  return (
    selected !== undefined &&
    request.method === selected.method &&
    target.pathname === selected.path &&
    target.search === "" &&
    selected.admit(body)
  );
}

function readOnlyRequest(request, target) {
  return (
    request.method === "GET" ||
    (request.method === "POST" && target.pathname === "/rest/api/2/search")
  );
}

/** Exact per-step transport witness. Production transport, credentials and ACK stay untouched. */
export function projectAgileWitness(session) {
  const origin = labSessionConnection(session).httpsOrigin;
  let selected;
  let strict = false;
  let state = { attempted: 0, forwarded: 0, statuses: [], blocked: 0 };
  return {
    arm(specification) {
      selected = specification;
      state = { attempted: 0, forwarded: 0, statuses: [], blocked: 0 };
      strict = Array.isArray(specification);
      if (strict) selected = wireSpecifications(specification);
    },
    snapshot: () => structuredClone(state),
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      // Arguments capture this request's armed step before any async resolver or native ACK.
      return (request) =>
        strict
          ? witnessedRequest(port, request, origin, selected, state)
          : witnessedLegacyRequest(port, request, origin, selected, state);
    },
  };
}

async function witnessedLegacyRequest(port, request, origin, selected, state) {
  const target = new URL(request.url);
  assert.equal(
    target.origin,
    origin,
    "Only the existing selected synthetic TLS frontend is observed",
  );
  if (readOnlyRequest(request, target)) return port(request);
  state.attempted += 1;
  const body = request.bodyJson === undefined ? undefined : JSON.parse(request.bodyJson);
  if (state.attempted !== 1 || !matchesLegacyStep(selected, request, target, body)) {
    state.blocked += 1;
    throw new TypeError("Lab blocked unexpected or repeated mutation; this journey cannot pass");
  }
  state.forwarded += 1;
  const result = await port(request);
  if (result.kind === "response") state.statuses.push(result.status);
  return result;
}

function blockWrite(state, code) {
  state.blocked += 1;
  throw new JourneyStepFailure(code, "wire");
}

function requestBody(request, state) {
  try {
    return request.bodyJson === undefined ? undefined : JSON.parse(request.bodyJson);
  } catch {
    return blockWrite(state, "wire-body-invalid");
  }
}

async function witnessedRequest(port, request, origin, selected, state) {
  let target;
  try {
    target = new URL(request.url);
  } catch {
    throw new JourneyStepFailure("wire-origin-mismatch", "wire");
  }
  requireJourneyCondition(target.origin === origin, "wire-origin-mismatch", "wire");
  if (readOnlyRequest(request, target)) return port(request);
  state.attempted += 1;
  const index = state.forwarded;
  if (state.blocked !== 0 || state.attempted !== index + 1)
    return blockWrite(state, "wire-unexpected-write");
  const body = requestBody(request, state);
  let matches;
  try {
    matches = matchesStep(selected[index], request, target, body);
    if (typeof matches !== "boolean") matches = await matches;
  } catch {
    return blockWrite(state, "wire-unexpected-write");
  }
  if (matches !== true || state.blocked !== 0) return blockWrite(state, "wire-unexpected-write");
  state.forwarded += 1;
  const result = await port(request);
  if (result.kind === "response") state.statuses[index] = result.status;
  return result;
}

/** Ordered native acknowledgements, including explicit refusal codes, prove exactly N dispatches. */
export function observedEffects(witness, specifications) {
  const expected = wireSpecifications(specifications);
  requireJourneyCondition(
    witness.blocked === 0 &&
      witness.forwarded === expected.length &&
      witness.attempted === expected.length,
    "wire-count-mismatch",
    "wire",
  );
  requireJourneyCondition(
    witness.statuses.length === expected.length,
    "wire-acknowledgement-missing",
    "wire",
  );
  for (let index = 0; index < expected.length; index += 1) {
    const status = witness.statuses[index];
    requireJourneyCondition(Number.isSafeInteger(status), "wire-acknowledgement-missing", "wire");
    const wanted = expected[index].status;
    requireJourneyCondition(
      wanted === undefined ? status >= 200 && status < 300 : status === wanted,
      "wire-status-mismatch",
      "wire",
    );
  }
}

export function oneObservedEffect(witness) {
  assert.equal(witness.blocked, 0);
  assert.equal(witness.forwarded, 1);
  assert.equal(witness.attempted, 1);
  assert.equal(witness.statuses.length, 1);
  assert.ok(witness.statuses[0] >= 200 && witness.statuses[0] < 300);
}

/** Reuse the canonical pager and retain how many actual native pages supplied the proof. */
export async function nativePageObservation(read, path, field) {
  let pages = 0;
  const values = await nativePages(
    async (target) => {
      pages += 1;
      return read(target);
    },
    path,
    field,
  );
  return { values, pages };
}

const BULK_READ_ALIASES = new Set([
  "jira_discover",
  "jira_describe",
  ...JIRA_MANAGED_READ_TOOLS.map((name) => name.replaceAll(/[.-]/gu, "_")),
]);

/** Transcript evidence is not a transport witness. Unknown/extra operations refuse qualification. */
export function sprintBulkTurn(
  turn,
  { operation, count = 1, admit, denied = false, requireApprovals = false },
) {
  const alias = operation.replaceAll(/[.-]/gu, "_");
  const selected = turn.exchanges.filter((entry) => entry.call.name === alias);
  assert.equal(
    selected.length,
    count,
    "Exactly the selected operations, without automatic retries",
  );
  for (const entry of turn.exchanges.filter((item) => item.call.name !== alias)) {
    assert.ok(BULK_READ_ALIASES.has(entry.call.name), "Unexpected operation is not a proven read");
    assert.notEqual(entry.effectStarted, true);
    assert.equal(entry.approval, undefined);
    assert.equal(entry.mutationOutcome, undefined);
  }
  assert.ok(Number.isSafeInteger(turn.decisions));
  if (requireApprovals) assert.equal(turn.decisions, denied ? 0 : count);
  else assert.ok(turn.decisions === 0 || (!denied && turn.decisions === count));
  for (const entry of selected) validateBulkReceipt(entry, operation, admit, denied);
  return selected.map((entry) => entry.result.data);
}

function validateBulkReceipt(entry, operation, admit, denied) {
  const result = entry.result;
  assert.ok(result !== undefined);
  const data = result.data;
  assert.ok(data !== undefined);
  assert.equal(result.toolRef?.canonicalId, canonicalToolId(operation));
  assert.equal(
    admit(entry.call.arguments),
    true,
    "Submitted arguments must match the bounded intent",
  );
  if (denied) {
    assert.equal(data.outcome, "rejected");
    assert.equal(data.reason, "invalid-transition");
    assert.notEqual(entry.effectStarted, true);
    assert.equal(entry.approval, undefined);
  } else {
    assert.notEqual(
      entry.approval?.state,
      "pending",
      "A completed effect cannot retain a pending approval",
    );
    assert.ok(new Set(["succeeded", "succeeded-unconfirmed", "unknown"]).has(data.outcome));
    assert.ok(new Set(["completed", "failed"]).has(result.status));
    if (data.outcome === "succeeded") assert.equal(result.status, "completed");
  }
}

/** Exact independent native ID/key pairs; neither ACK ordering nor duplicated keys prove a set. */
export function exactSprintBulkIssues(issues, references) {
  assert.equal(new Set(references.map((item) => item.key)).size, references.length);
  assert.equal(new Set(references.map((item) => item.id)).size, references.length);
  assert.equal(new Set(issues.map((item) => item.key)).size, issues.length);
  assert.equal(new Set(issues.map((item) => observedId(item.id))).size, issues.length);
  const pairs = (values) => values.map((item) => `${observedId(item.id)}:${item.key}`).sort();
  assert.deepEqual(pairs(issues), pairs(references));
}

async function nativeLiveSprintIds(read, issue, sprintFieldId, states) {
  assert.equal(
    Object.hasOwn(issue.fields, sprintFieldId),
    true,
    "Missing native field is unavailable membership proof",
  );
  const raw = issue.fields[sprintFieldId];
  const entries = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const ids = sprintIdsOf(raw).map(String);
  assert.equal(ids.length, entries.length, "Malformed Sprint metadata is unavailable proof");
  assert.equal(new Set(ids).size, ids.length);
  const live = [];
  for (const id of ids) {
    if (!states.has(id)) {
      const sprint = await read(`/rest/agile/1.0/sprint/${id}`);
      assert.equal(observedId(sprint.id), id);
      assert.ok(new Set(["future", "active", "closed"]).has(sprint.state));
      states.set(id, sprint.state);
    }
    if (states.get(id) !== "closed") live.push(id);
  }
  return live;
}

/** Closed historical memberships may coexist; live/future membership remains exclusive. */
export async function sprintBulkLiveMembership(read, issues, sprintFieldId, expectedLiveId) {
  const states = new Map();
  for (const issue of issues) {
    const live = await nativeLiveSprintIds(read, issue, sprintFieldId, states);
    assert.deepEqual(live, expectedLiveId === undefined ? [] : [expectedLiveId]);
  }
}

export function sprintBulkInboundTasks(issues, scope) {
  assert.equal(new Set(issues.map((issue) => observedId(issue.id))).size, issues.length);
  assert.equal(new Set(issues.map((issue) => issue.key)).size, issues.length);
  for (const issue of issues) {
    assert.match(issue.key, new RegExp(`^${scope.projectKey}-[1-9][0-9]*$`, "u"));
    assert.equal(issue.fields.project.key, scope.projectKey);
    assert.equal(observedId(issue.fields.project.id), scope.projectId);
    assert.equal(observedId(issue.fields.issuetype.id), scope.taskTypeId);
    assert.equal(issue.fields.issuetype.name, "Task");
  }
}

function issueIdOrder(left, right) {
  const first = BigInt(observedId(left.id));
  const second = BigInt(observedId(right.id));
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

/** Stable native selection excludes Done/rightmost-column Tasks and every live Sprint assignment. */
export async function sprintBulkEligibleTasks(read, issues, scope) {
  sprintBulkInboundTasks(issues, scope);
  const states = new Map();
  const eligible = [];
  for (const issue of [...issues].sort(issueIdOrder)) {
    const category = issue.fields.status?.statusCategory?.key;
    assert.ok(new Set(["new", "indeterminate", "done"]).has(category));
    if (category === "done" || scope.doneStatuses.has(observedId(issue.fields.status.id))) continue;
    if (!scope.epicKeys.has(issue.fields[scope.epicFieldId])) continue;
    if ((await nativeLiveSprintIds(read, issue, scope.sprintFieldId, states)).length !== 0)
      continue;
    eligible.push(issue);
  }
  return eligible;
}

export function sprintBulkClosedIssues(issues, references, doneKeys, backlog) {
  exactSprintBulkIssues(issues, references);
  assert.equal(new Set(doneKeys).size, doneKeys.length);
  assert.ok(doneKeys.length > 0 && doneKeys.length < references.length);
  const expected = new Set(references.map((item) => item.key));
  assert.ok(doneKeys.every((key) => expected.has(key)));
  const done = new Set(doneKeys);
  const backlogKeys = new Set(backlog.map((issue) => issue.key));
  assert.equal(backlogKeys.size, backlog.length);
  for (const issue of issues) {
    assert.equal(issue.fields.status?.statusCategory?.key === "done", done.has(issue.key));
    assert.equal(
      backlogKeys.has(issue.key),
      !done.has(issue.key),
      "Only unfinished selected Tasks return to backlog",
    );
  }
}
