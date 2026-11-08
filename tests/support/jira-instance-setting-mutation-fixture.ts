import assert from "node:assert/strict";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
export const INSTANCE_SETTING_FIXTURE_CASES = [
  {
    name: "jira.set-application-property",
    args: {
      expectedActorKey: ACTOR,
      propertyKey: "jira.option.voting",
      expectedValue: true,
      value: false,
    },
    path: "application-properties/jira.option.voting",
    body: { id: "jira.option.voting", value: "false" },
    receipt: { userKey: ACTOR, propertyKey: "jira.option.voting", valueDigest: sha256Hex("false") },
    confirmed: true,
  },
  {
    name: "jira.set-system-columns",
    args: {
      expectedActorKey: ACTOR,
      expectedColumns: ["issuekey", "summary"],
      columns: ["summary", "issuekey", "summary"],
    },
    path: "settings/columns",
    body: { columns: ["summary", "issuekey", "summary"] },
    receipt: { userKey: ACTOR, columnIds: ["summary", "issuekey", "summary"] },
    confirmed: true,
  },
  {
    name: "jira.set-instance-base-url",
    args: {
      expectedActorKey: ACTOR,
      expectedBaseUrl: "http://legacy.synthetic.invalid/jira",
      configuredBaseUrl: "https://next.synthetic.invalid/context",
      confirmInstanceWide: true,
    },
    path: "settings/baseUrl",
    body: "https://next.synthetic.invalid/context",
    receipt: { userKey: ACTOR, baseUrlDigest: sha256Hex("https://next.synthetic.invalid/context") },
    confirmed: false,
  },
  {
    name: "jira.set-read-only-mode",
    args: {
      expectedActorKey: ACTOR,
      expectedEnabled: false,
      enabled: true,
      confirmInstanceWide: true,
    },
    path: "readonly-mode",
    body: { enabled: true },
    receipt: { userKey: ACTOR, readOnlyEnabled: true },
    confirmed: true,
  },
] as const;
interface InstanceSettingValues {
  columns: string[];
  baseUrl: unknown;
  enabled: unknown;
  message: string;
  endTime: string;
  timeZone: string;
}
interface InstanceSettingControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  wrongReadback: boolean;
  propertyArray: boolean;
  wrongPropertyKey: boolean;
  duplicateProperty: boolean;
  actorChanges: boolean;
  acknowledgementStatus: number;
}
interface InstanceSettingState {
  readonly actor: { key: string; name: string };
  readonly properties: Map<string, unknown>;
  readonly values: InstanceSettingValues;
  readonly fields: unknown[];
  readonly controls: InstanceSettingControls;
  readonly calls: { path: string; method: string; body: unknown; expect: unknown }[];
  wrote: boolean;
}
export interface InstanceSettingMutationFixture {
  readonly request: JiraMutationRequest;
  readonly calls: InstanceSettingState["calls"];
  readonly controls: InstanceSettingControls;
  readonly actor: InstanceSettingState["actor"];
  readonly properties: Map<string, unknown>;
  readonly state: InstanceSettingValues;
  readonly fields: unknown[];
  snapshot(): CatalogJsonObject;
}
type InstanceSettingBody = Parameters<JiraMutationRequest>[2];

function settingOk(body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}

/** True once an effect landed and the fixture is told to misreport the readback. */
function settingWrongReadback(state: InstanceSettingState): boolean {
  return state.wrote && state.controls.wrongReadback;
}

function settingPropertyRead(state: InstanceSettingState, url: URL): AtlassianWriteHttpOutcome {
  const { controls } = state;
  const key = url.searchParams.get("key");
  assert.ok(key);
  const item = {
    key: controls.wrongPropertyKey ? "jira.clone.prefix" : key,
    value: settingWrongReadback(state) ? "true" : state.properties.get(key),
  };
  return controls.propertyArray
    ? {
        ok: true,
        status: 200,
        body: undefined,
        items: controls.duplicateProperty ? [item, item] : [item],
      }
    : settingOk(item);
}

function settingColumnsRead(state: InstanceSettingState): AtlassianWriteHttpOutcome {
  return {
    ok: true,
    status: 200,
    body: undefined,
    items: (settingWrongReadback(state) ? ["summary"] : state.values.columns).map((value) => ({
      value,
      label: "Native label",
    })),
  };
}

function settingServerInfoRead(state: InstanceSettingState): AtlassianWriteHttpOutcome {
  return settingOk({
    version: "11.3.3",
    versionNumbers: [11, 3, 3],
    deploymentType: "Data Center",
    baseUrl: settingWrongReadback(state) ? "https://other.synthetic.invalid" : state.values.baseUrl,
  });
}

function settingReadOnlyRead(state: InstanceSettingState): AtlassianWriteHttpOutcome {
  const { values } = state;
  return settingOk({
    enabled: settingWrongReadback(state) ? false : values.enabled,
    message: values.message,
    endTime: values.endTime,
    timeZone: values.timeZone,
  });
}

function settingRead(state: InstanceSettingState, url: URL): AtlassianWriteHttpOutcome {
  switch (url.pathname) {
    case "/myself":
      return settingOk({
        ...state.actor,
        ...(state.wrote && state.controls.actorChanges ? { key: "other-actor" } : {}),
      });
    case "/application-properties":
      return settingPropertyRead(state, url);
    case "/settings/columns":
      return settingColumnsRead(state);
    case "/field":
      return { ok: true, status: 200, body: undefined, items: structuredClone(state.fields) };
    case "/serverInfo":
      return settingServerInfoRead(state);
    case "/readonly-mode":
      return settingReadOnlyRead(state);
    default:
      throw new TypeError("Unexpected synthetic instance setting read");
  }
}

function applyPropertyEffect(
  state: InstanceSettingState,
  url: URL,
  raw: Record<string, unknown> | undefined,
): void {
  const key = url.pathname.slice("/application-properties/".length);
  assert.ok(raw);
  assert.deepEqual(Object.keys(raw).sort(), ["id", "value"]);
  assert.equal(raw.id, key);
  assert.equal(typeof raw.value, "string");
  state.properties.set(key, raw.value);
}

function applyColumnsEffect(
  state: InstanceSettingState,
  raw: Record<string, unknown> | undefined,
): void {
  assert.ok(raw);
  assert.deepEqual(Object.keys(raw), ["columns"]);
  assert.ok(Array.isArray(raw.columns));
  state.values.columns = raw.columns.map((value) => {
    assert.equal(typeof value, "string");
    return String(value);
  });
}

function applyReadOnlyEffect(
  state: InstanceSettingState,
  raw: Record<string, unknown> | undefined,
): void {
  assert.ok(raw);
  assert.deepEqual(Object.keys(raw), ["enabled"]);
  assert.equal(typeof raw.enabled, "boolean");
  state.values.enabled = raw.enabled;
}

function applySettingEffect(
  state: InstanceSettingState,
  url: URL,
  body: InstanceSettingBody,
): void {
  const raw = asRecord(body);
  if (url.pathname.startsWith("/application-properties/")) applyPropertyEffect(state, url, raw);
  else if (url.pathname === "/settings/columns") applyColumnsEffect(state, raw);
  else if (url.pathname === "/settings/baseUrl") {
    assert.equal(typeof body, "string");
    state.values.baseUrl = body;
  } else if (url.pathname === "/readonly-mode") applyReadOnlyEffect(state, raw);
  else throw new TypeError("Unexpected synthetic instance setting effect");
}

function settingEffect(
  state: InstanceSettingState,
  url: URL,
  body: InstanceSettingBody,
): AtlassianWriteHttpOutcome {
  applySettingEffect(state, url, body);
  state.wrote = true;
  return state.controls.lostAck
    ? { ok: false, reason: "timeout" }
    : { ok: true, status: state.controls.acknowledgementStatus, body: undefined };
}

function settingReadbackFault(state: InstanceSettingState): AtlassianWriteHttpOutcome | undefined {
  if (!state.wrote) return undefined;
  if (state.controls.throwReadback) throw new Error("Synthetic instance setting readback defect");
  if (state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return undefined;
}

function settingResponse(
  state: InstanceSettingState,
  path: string,
  method: string,
  body: InstanceSettingBody,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  state.calls.push({ path, method, body: structuredClone(body), expect });
  const fault = settingReadbackFault(state);
  if (fault !== undefined) return fault;
  // This simulated port remains bound; the desired base URL is only a scalar body.
  const url = new URL(path, "https://bound.synthetic.invalid/");
  if (method === "GET") return settingRead(state, url);
  assert.equal(method, "PUT");
  return settingEffect(state, url, body);
}

function initialInstanceSettingState(): InstanceSettingState {
  return {
    actor: { key: ACTOR, name: "operator" },
    properties: new Map<string, unknown>([
      ["jira.clone.prefix", "CLONE - "],
      ["jira.option.voting", "true"],
      ["jira.option.watching", "true"],
      ["jira.option.timetracking", "false"],
    ]),
    values: {
      columns: ["issuekey", "summary"],
      baseUrl: "http://legacy.synthetic.invalid/jira",
      enabled: false,
      message: "Existing banner",
      endTime: "2026-11-09T18:00",
      timeZone: "Europe/Berlin",
    },
    fields: [
      { id: "issuekey", name: "Key", navigable: true },
      { id: "summary", name: "Summary", navigable: true },
    ],
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      wrongReadback: false,
      propertyArray: false,
      wrongPropertyKey: false,
      duplicateProperty: false,
      actorChanges: false,
      acknowledgementStatus: 204,
    },
    calls: [],
    wrote: false,
  };
}

export function instanceSettingMutationFixture(): InstanceSettingMutationFixture {
  const state = initialInstanceSettingState();
  const { values, properties } = state;
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => settingResponse(state, path, method, body, expect));
  return {
    request,
    calls: state.calls,
    controls: state.controls,
    actor: state.actor,
    properties,
    state: values,
    fields: state.fields,
    snapshot: (): CatalogJsonObject => ({
      columns: [...values.columns],
      baseUrl: typeof values.baseUrl === "string" ? values.baseUrl : null,
      enabled: typeof values.enabled === "boolean" ? values.enabled : null,
      banner: values.message,
      endTime: values.endTime,
      timeZone: values.timeZone,
      voting: String(properties.get("jira.option.voting")),
    }),
  };
}
