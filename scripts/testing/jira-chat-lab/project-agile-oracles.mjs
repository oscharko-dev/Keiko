import assert from "node:assert/strict";
import { URL } from "node:url";
import { basicAuth, labRequest, labSessionConnection } from "./lab-client.mjs";

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

function matchesStep(selected, request, target, body) {
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
  let state = { attempted: 0, forwarded: 0, statuses: [], blocked: 0 };
  return {
    arm(specification) {
      selected = specification;
      state = { attempted: 0, forwarded: 0, statuses: [], blocked: 0 };
    },
    snapshot: () => structuredClone(state),
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      return async (request) => {
        const target = new URL(request.url);
        assert.equal(
          target.origin,
          origin,
          "Only the existing selected synthetic TLS frontend is observed",
        );
        if (readOnlyRequest(request, target)) return port(request);
        state.attempted += 1;
        const body = request.bodyJson === undefined ? undefined : JSON.parse(request.bodyJson);
        if (state.attempted !== 1 || !matchesStep(selected, request, target, body)) {
          state.blocked += 1;
          throw new TypeError(
            "Lab blocked unexpected or repeated mutation; this journey cannot pass",
          );
        }
        state.forwarded += 1;
        const result = await port(request);
        if (result.kind === "response") state.statuses.push(result.status);
        return result;
      };
    },
  };
}

export function oneObservedEffect(witness) {
  assert.equal(witness.blocked, 0);
  assert.equal(witness.forwarded, 1);
  assert.equal(witness.attempted, 1);
  assert.equal(witness.statuses.length, 1);
  assert.ok(witness.statuses[0] >= 200 && witness.statuses[0] < 300);
}
