import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { basicAuth, checked } from "./lab-client.mjs";

const WRITES = new Set([
  "jira.create",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.transition",
]);
export const RESTRICTED_REFUSAL_DIAGNOSTICS = new Map([
  [400, "field-validation"],
  [403, "permission-denied"],
  [404, "not-found"],
]);
const PERMISSION_REASONS = new Set(["permission-denied", "not-found", "field-validation"]);

export function adminRead(session, path) {
  return checked(
    session,
    "restricted-independent-observation",
    "GET",
    path,
    basicAuth(session, "admin"),
  );
}

/** Complete bounded project snapshots include comment totals and bodies only in private memory. */
export async function restrictedRemoteState(session) {
  const query = new URLSearchParams({
    jql: "project in (KEIKO, ISOLATED) ORDER BY key",
    fields: "summary,updated,status,resolution,assignee,comment",
    maxResults: "100",
  });
  const value = await adminRead(session, `/rest/api/2/search?${query}`);
  assert.ok(Number.isSafeInteger(value.total) && value.total <= 100);
  assert.equal(value.issues.length, value.total);
  return {
    count: value.total,
    digest: createHash("sha256").update(JSON.stringify(value.issues)).digest("hex"),
    issues: value.issues,
  };
}

/** The original custody/TLS/HTTP implementation remains the sole outgoing transport. */
export function restrictedDispatchObserver() {
  let current;
  let state;
  return {
    arm: (testCase) => {
      current = testCase;
      state = { attempts: 0, forwarded: 0, status: 0 };
    },
    snapshot: () => ({ ...state }),
    decorate: (factory) => (metadata, correlationId, lifecycle) => {
      const port = factory(metadata, correlationId, lifecycle);
      return async (request) => {
        if (request.method === "GET") return port(request);
        assert.ok(current && state, "No mutation was selected for qualification");
        state.attempts += 1;
        assert.ok(state.attempts <= current.dispatches, "Unexpected or repeated mutation blocked");
        assert.equal(request.method, current.target.method);
        assert.equal(new URL(request.url).pathname, current.target.path);
        assert.deepEqual(JSON.parse(request.bodyJson), current.target.body);
        state.forwarded += 1;
        const observed = await port(request);
        if (observed.kind === "response") state.status = observed.status;
        return observed;
      };
    },
  };
}

function readCase(id, actor, issueKey, outcome = "succeeded") {
  return { id, actor, operation: "jira.issue", arguments: { issueKey }, outcome, dispatches: 0 };
}
function isolatedCases(fixture, marker) {
  return [
    readCase("isolated-read", "restricted", fixture.isolationIssueKey),
    readCase("cross-project-read-refused", "restricted", fixture.issueKeys[0], "failed"),
    {
      id: "isolated-comment-refused",
      actor: "restricted",
      operation: "jira.comment",
      arguments: { issueKey: fixture.isolationIssueKey, body: marker },
      outcome: "unknown",
      dispatches: 1,
      statuses: [400, 403, 404],
      target: {
        method: "POST",
        path: `/rest/api/2/issue/${fixture.isolationIssueKey}/comment`,
        body: { body: marker },
      },
    },
  ];
}
function editorCases(fixture, marker, transitionArgs, resolution) {
  const key = fixture.issueKeys[0];
  return [
    readCase("editor-read", "editor", key),
    {
      id: "editor-edit",
      actor: "editor",
      operation: "jira.edit",
      arguments: { issueKey: key, fields: { summary: marker } },
      outcome: "succeeded",
      dispatches: 1,
      statuses: [204],
      target: {
        method: "PUT",
        path: `/rest/api/2/issue/${key}`,
        body: { fields: { summary: marker }, update: {} },
      },
    },
    {
      id: "editor-transition-refused",
      actor: "editor",
      operation: "jira.transition",
      arguments: { ...transitionArgs, fields: { [fixture.requiredFieldId]: marker, resolution } },
      outcome: "rejected",
      dispatches: 0,
      reasons: ["permission-denied", "not-found", "invalid-transition"],
    },
  ];
}
export function focusedRestrictedCases(fixture, projectId, transition, id) {
  const marker = `Synthetic restricted ${id}`;
  const resolution = { id: transition.fields.resolution.allowedValues[0].id };
  const transitionArgs = { issueKey: fixture.issueKeys[2], transitionId: transition.id };
  return [
    ...isolatedCases(fixture, marker),
    ...editorCases(fixture, marker, transitionArgs, resolution),
    {
      id: "required-create-field-omitted",
      actor: "api",
      operation: "jira.create",
      arguments: { projectId, issueTypeId: fixture.issueTypeId, fields: { summary: marker } },
      outcome: "rejected",
      dispatches: 0,
      requiredFieldRefusal: true,
    },
    {
      id: "required-transition-field-omitted",
      actor: "api",
      operation: "jira.transition",
      arguments: { ...transitionArgs, fields: { resolution } },
      outcome: "rejected",
      dispatches: 0,
      requiredFieldRefusal: true,
    },
  ];
}

/** Resolve permission refusals from the observed dispatch boundary, never from a guessed ACL. */
export function restrictedCaseAtDispatch(testCase, dispatch) {
  if (testCase.localRefusalAllowed !== true) return testCase;
  assert.equal(dispatch.attempts, dispatch.forwarded);
  assert.ok(dispatch.forwarded === 0 || dispatch.forwarded === 1);
  return dispatch.forwarded === 0 ? { ...testCase, outcome: "rejected", dispatches: 0 } : testCase;
}

export function verifyRestrictedTurn(observed, testCase, transport, dispatch) {
  const user = observed.completed.messages.find((message) => message.role === "user");
  assert.equal(user?.turnState, "completed");
  assert.equal(typeof user.id, "string");
  assert.equal(observed.decisions.grants, 1);
  const mutation = WRITES.has(testCase.operation);
  const exchanges = user.toolTranscript.exchanges;
  assert.equal(exchanges.length, 1, "Qualification requires exactly the selected call");
  const exchange = exchanges[0];
  assert.equal(typeof exchange.call.id, "string");
  assert.equal(typeof exchange.result.invocationId, "string");
  assert.equal(exchange.call.name, testCase.operation.replace(/[.-]/gu, "_"));
  assert.deepEqual(exchange.call.arguments, testCase.arguments);
  assert.equal(exchange.result.status, testCase.outcome === "succeeded" ? "completed" : "failed");
  assert.equal(exchange.result.data.outcome, testCase.outcome);
  assert.equal(exchange.mutationOutcome, mutation ? testCase.outcome : undefined);
  assert.equal(dispatch.attempts, testCase.dispatches);
  assert.equal(dispatch.forwarded, testCase.dispatches);
  if (testCase.dispatches > 0) {
    assert.ok(testCase.statuses.includes(dispatch.status));
    if (testCase.outcome !== "succeeded")
      assert.equal(
        exchange.result.data.reason,
        RESTRICTED_REFUSAL_DIAGNOSTICS.get(dispatch.status),
      );
  } else assert.equal(dispatch.status, 0);
  verifyRestrictedConsent(observed, mutation, testCase, transport);
  verifyRestrictedData(exchange, testCase);
  return exchange;
}

function verifyRestrictedConsent(observed, mutation, testCase, transport) {
  const approvals = observed.decisions.approvals;
  // A metadata refusal may precede approval; an actual write always requires exact approval.
  if (mutation && testCase.dispatches === 0) assert.ok(approvals === 0 || approvals === 1);
  else assert.equal(approvals, mutation ? 1 : 0);
  if (transport === "stream") {
    assert.ok(observed.events.has("tool-read-consent"));
    assert.equal(observed.events.has("tool-write-approval"), approvals > 0);
  }
}

function verifyRestrictedData(exchange, testCase) {
  const data = exchange.result.data;
  if (testCase.outcome !== "succeeded") {
    assert.ok(new Set(testCase.reasons ?? PERMISSION_REASONS).has(data.reason));
    assert.equal(exchange.result.reason, "provider-reported-error");
    assert.equal(data.items, undefined);
    if (testCase.requiredFieldRefusal) assert.equal(data.reason, "field-validation");
  } else if (!WRITES.has(testCase.operation)) {
    if (testCase.readExpected !== undefined) {
      const expected = testCase.readExpected;
      assert.deepEqual(data.items.map((item) => item[expected.field]).toSorted(), expected.values);
    } else {
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].key, testCase.arguments.issueKey);
    }
  }
}
