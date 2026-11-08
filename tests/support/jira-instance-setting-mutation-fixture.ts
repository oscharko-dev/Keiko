import assert from "node:assert/strict";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
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
export function instanceSettingMutationFixture() {
  const actor = { key: ACTOR, name: "operator" };
  const properties = new Map<string, unknown>([
    ["jira.clone.prefix", "CLONE - "],
    ["jira.option.voting", "true"],
    ["jira.option.watching", "true"],
    ["jira.option.timetracking", "false"],
  ]);
  const state: {
    columns: string[];
    baseUrl: unknown;
    enabled: unknown;
    message: string;
    endTime: string;
    timeZone: string;
  } = {
    columns: ["issuekey", "summary"],
    baseUrl: "http://legacy.synthetic.invalid/jira",
    enabled: false,
    message: "Existing banner",
    endTime: "2026-11-09T18:00",
    timeZone: "Europe/Berlin",
  };
  const fields: unknown[] = [
    { id: "issuekey", name: "Key", navigable: true },
    { id: "summary", name: "Summary", navigable: true },
  ];
  const controls = {
    lostAck: false,
    denyReadback: false,
    throwReadback: false,
    wrongReadback: false,
    propertyArray: false,
    wrongPropertyKey: false,
    duplicateProperty: false,
    actorChanges: false,
    acknowledgementStatus: 204,
  };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  let wrote = false;
  const ok = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({
    ok: true,
    status: 200,
    body,
  });
  function read(url: URL): AtlassianWriteHttpOutcome {
    if (url.pathname === "/myself")
      return ok({ ...actor, ...(wrote && controls.actorChanges ? { key: "other-actor" } : {}) });
    if (url.pathname === "/application-properties") {
      const key = url.searchParams.get("key");
      assert.ok(key);
      const item = {
        key: controls.wrongPropertyKey ? "jira.clone.prefix" : key,
        value: wrote && controls.wrongReadback ? "true" : properties.get(key),
      };
      return controls.propertyArray
        ? {
            ok: true,
            status: 200,
            body: undefined,
            items: controls.duplicateProperty ? [item, item] : [item],
          }
        : ok(item);
    }
    if (url.pathname === "/settings/columns")
      return {
        ok: true,
        status: 200,
        body: undefined,
        items: (wrote && controls.wrongReadback ? ["summary"] : state.columns).map((value) => ({
          value,
          label: "Native label",
        })),
      };
    if (url.pathname === "/field")
      return { ok: true, status: 200, body: undefined, items: structuredClone(fields) };
    if (url.pathname === "/serverInfo")
      return ok({
        version: "11.3.3",
        versionNumbers: [11, 3, 3],
        deploymentType: "Data Center",
        baseUrl:
          wrote && controls.wrongReadback ? "https://other.synthetic.invalid" : state.baseUrl,
      });
    if (url.pathname === "/readonly-mode")
      return ok({
        enabled: wrote && controls.wrongReadback ? false : state.enabled,
        message: state.message,
        endTime: state.endTime,
        timeZone: state.timeZone,
      });
    throw new TypeError("Unexpected synthetic instance setting read");
  }
  function effect(url: URL, body: Parameters<JiraMutationRequest>[2]): AtlassianWriteHttpOutcome {
    const raw = asRecord(body);
    if (url.pathname.startsWith("/application-properties/")) {
      const key = url.pathname.slice("/application-properties/".length);
      assert.ok(raw);
      assert.deepEqual(Object.keys(raw).sort(), ["id", "value"]);
      assert.equal(raw.id, key);
      assert.equal(typeof raw.value, "string");
      properties.set(key, raw.value);
    } else if (url.pathname === "/settings/columns") {
      assert.ok(raw);
      assert.deepEqual(Object.keys(raw), ["columns"]);
      assert.ok(Array.isArray(raw.columns));
      state.columns = raw.columns.map((value) => {
        assert.equal(typeof value, "string");
        return String(value);
      });
    } else if (url.pathname === "/settings/baseUrl") {
      assert.equal(typeof body, "string");
      state.baseUrl = body;
    } else if (url.pathname === "/readonly-mode") {
      assert.ok(raw);
      assert.deepEqual(Object.keys(raw), ["enabled"]);
      assert.equal(typeof raw.enabled, "boolean");
      state.enabled = raw.enabled;
    } else throw new TypeError("Unexpected synthetic instance setting effect");
    wrote = true;
    return controls.lostAck
      ? { ok: false, reason: "timeout" }
      : { ok: true, status: controls.acknowledgementStatus, body: undefined };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (wrote && controls.throwReadback)
      throw new Error("Synthetic instance setting readback defect");
    if (wrote && controls.denyReadback)
      return { ok: false, reason: "permission-denied", httpStatus: 403 };
    // This simulated port remains bound; the desired base URL is only a scalar body.
    const url = new URL(path, "https://bound.synthetic.invalid/");
    if (method === "GET") return read(url);
    assert.equal(method, "PUT");
    return effect(url, body);
  };
  return {
    request,
    calls,
    controls,
    actor,
    properties,
    state,
    fields,
    snapshot: (): CatalogJsonObject => ({
      columns: [...state.columns],
      baseUrl: typeof state.baseUrl === "string" ? state.baseUrl : null,
      enabled: typeof state.enabled === "boolean" ? state.enabled : null,
      banner: state.message,
      endTime: state.endTime,
      timeZone: state.timeZone,
      voting: String(properties.get("jira.option.voting")),
    }),
  };
}
