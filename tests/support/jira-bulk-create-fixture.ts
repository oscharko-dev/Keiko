import { dispatchFixtureCall } from "./jira-fixture-readback.js";
import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import { field, LINKS_FIELD } from "./jira-managed-remote.js";

export const BULK_CREATE_ARGUMENTS = {
  expectedActorKey: "synthetic-actor",
  confirmUnverifiedEffect: true,
  issues: [
    { projectId: "10000", issueTypeId: "3", fields: { summary: "First reviewed issue" } },
    { projectId: "10000", issueTypeId: "3", fields: { summary: "Second reviewed issue" } },
  ],
} as const;
export const BULK_CREATE_RECEIPT = {
  userKey: "synthetic-actor",
  requestedIssueCount: 2,
  issueIds: ["10001", "9223372036854775807"],
  issueKeys: ["SYN-1", "SYN-2"],
} as const;
interface BulkCreateControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  actorChangesBefore: boolean;
  wrongReadback: boolean;
  includeLabels: boolean;
  includeLinks: boolean;
  duplicateExists: boolean;
  requiredCustom: boolean;
  reject: boolean;
  ackStatus: number;
}
interface BulkCreateState {
  readonly actor: { key: string; name: string };
  readonly calls: { path: string; method: string; body: unknown; expect: unknown }[];
  readonly controls: BulkCreateControls;
  effects: number;
  body: unknown;
  acknowledgement: Record<string, unknown>;
}
export interface BulkCreateFixture {
  readonly request: JiraMutationRequest;
  readonly actor: { key: string; name: string };
  readonly calls: BulkCreateState["calls"];
  readonly controls: BulkCreateControls;
  setAcknowledgement(value: Record<string, unknown>): void;
  submitted(): unknown;
  snapshot(): CatalogJsonObject;
}

function bulkOk(value: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: value };
}

function bulkCreateMeta(url: URL, controls: BulkCreateControls): AtlassianWriteHttpOutcome {
  assert.equal(url.searchParams.get("startAt"), "0");
  assert.equal(url.searchParams.get("maxResults"), "100");
  const values = [
    field("project", "project", true),
    field("issuetype", "issuetype", true),
    field("summary", "string", true),
    field("description", "string"),
  ];
  if (controls.includeLabels)
    values.push({
      ...field("labels", "array"),
      schema: { type: "array", items: "string", system: "labels" },
    });
  if (controls.includeLinks) values.push(LINKS_FIELD);
  if (controls.requiredCustom)
    values.push({
      ...field("customfield_10000", "string", true),
      schema: {
        type: "string",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      },
    });
  return bulkOk({ startAt: 0, maxResults: 100, isLast: true, total: values.length, values });
}

function bulkSearchRead(controls: BulkCreateControls): AtlassianWriteHttpOutcome {
  return bulkOk({
    startAt: 0,
    maxResults: 50,
    total: controls.duplicateExists ? 1 : 0,
    issues: controls.duplicateExists
      ? [{ id: "10009", key: "SYN-9", fields: { summary: "First reviewed issue" } }]
      : [],
  });
}

function bulkIssueRead(url: URL, controls: BulkCreateControls): AtlassianWriteHttpOutcome {
  const id = url.pathname.slice("/issue/".length);
  assert.ok(id === "10001" || id === "9223372036854775807");
  assert.equal(url.searchParams.get("fields"), "issuetype,project,summary");
  return bulkOk({
    id: controls.wrongReadback ? "10099" : id,
    key: id === "10001" ? "SYN-1" : "SYN-2",
    fields: {
      summary: id === "10001" ? "First reviewed issue" : "Second reviewed issue",
      project: { id: "10000" },
      issuetype: { id: "3" },
    },
  });
}

function bulkActorRead(state: BulkCreateState): AtlassianWriteHttpOutcome {
  const count = state.calls.filter((call) => call.path === "myself").length;
  return bulkOk({
    ...state.actor,
    key: state.controls.actorChangesBefore && count > 1 ? "changed-actor" : state.actor.key,
  });
}

function bulkRead(state: BulkCreateState, path: string): AtlassianWriteHttpOutcome {
  if (path === "myself") return bulkActorRead(state);
  const url = new URL(path, "https://synthetic.invalid/");
  if (url.pathname === "/project/10000")
    return bulkOk({ id: "10000", key: "SYN", name: "Synthetic" });
  if (url.pathname === "/issuetype/3") return bulkOk({ id: "3", name: "Story" });
  if (url.pathname === "/issue/createmeta/10000/issuetypes/3")
    return bulkCreateMeta(url, state.controls);
  if (url.pathname === "/search") return bulkSearchRead(state.controls);
  return bulkIssueRead(url, state.controls);
}

function bulkEffect(
  state: BulkCreateState,
  path: string,
  method: string,
  value: unknown,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  assert.equal(path, "issue/bulk");
  assert.equal(method, "POST");
  assert.equal(expect, "json");
  const payload = asRecord(value);
  assert.ok(payload);
  assert.ok(Array.isArray(payload.issueUpdates));
  assert.equal(payload.issueUpdates.length, 2);
  state.body = structuredClone(value);
  assert.equal(++state.effects, 1);
  const { controls } = state;
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  if (controls.reject) return { ok: false, reason: "field-validation", httpStatus: 400 };
  return {
    ok: true,
    status: controls.ackStatus,
    body: structuredClone(state.acknowledgement),
  };
}

function bulkResponse(
  state: BulkCreateState,
  path: string,
  method: string,
  value: unknown,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  return dispatchFixtureCall(
    state,
    { path, method, body: value, expect },
    "Synthetic bulk readback failure",
    {
      read: (readPath) => bulkRead(state, readPath),
      write: (call) => bulkEffect(state, call.path, call.method, call.body, call.expect),
    },
  );
}

export function bulkCreateFixture(): BulkCreateFixture {
  const state: BulkCreateState = {
    actor: { key: "synthetic-actor", name: "operator" },
    calls: [],
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      actorChangesBefore: false,
      wrongReadback: false,
      includeLabels: false,
      includeLinks: true,
      duplicateExists: false,
      requiredCustom: false,
      reject: false,
      ackStatus: 201,
    },
    effects: 0,
    body: undefined,
    acknowledgement: {
      issues: [
        { id: "10001", key: "SYN-1" },
        { id: "9223372036854775807", key: "SYN-2" },
      ],
      errors: [],
    },
  };
  const request: JiraMutationRequest = (path, method = "GET", value, expect) =>
    settleSync(() => bulkResponse(state, path, method, value, expect));
  return {
    request,
    actor: state.actor,
    calls: state.calls,
    controls: state.controls,
    setAcknowledgement(value: Record<string, unknown>): void {
      state.acknowledgement = value;
    },
    submitted: (): unknown => state.body,
    snapshot: (): CatalogJsonObject => ({ effects: state.effects }),
  };
}
