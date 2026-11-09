import assert from "node:assert/strict";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { settleSync } from "./jira-fixture-settle.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";

const VERSION_LINK_SNAPSHOT = {
  name: "Reviewed release",
  description: null,
  startDate: null,
  releaseDate: null,
  released: false,
  archived: false,
} as const;
export const VERSION_LINK_OLD_NODES = [
  { path: "", kind: "object", childCount: 2 },
  { path: "/globalId", kind: "string", textValue: "release:link" },
  { path: "/flag", kind: "boolean", booleanValue: false },
] as const;
const VERSION_LINK_NEW_NODES = [
  { path: "", kind: "object", childCount: 2 },
  { path: "/globalId", kind: "string", textValue: "release:link" },
  { path: "/flag", kind: "boolean", booleanValue: true },
] as const;
export const VERSION_LINK_EXPECTED = [
  { globalId: "release:link", valueNodes: VERSION_LINK_OLD_NODES },
  { globalId: "other:link", valueNodes: [{ path: "", kind: "null" }] },
] as const;
export const VERSION_LINK_CONTEXT = {
  versionId: "81",
  expectedProjectId: "10000",
  expectedActorKey: "synthetic-actor",
  expectedVersionSnapshot: VERSION_LINK_SNAPSHOT,
  expectedLinks: VERSION_LINK_EXPECTED,
} as const;
const RECEIPT = {
  versionId: "81",
  projectId: "10000",
  projectKey: "SYN",
  userKey: "synthetic-actor",
};
export const VERSION_LINK_MUTATION_CASES = [
  {
    tool: "jira.upsert-version-remote-link",
    method: "POST",
    path: "version/81/remotelink",
    args: { ...VERSION_LINK_CONTEXT, globalId: "release:link", valueNodes: VERSION_LINK_NEW_NODES },
    nativeBody: { globalId: "release:link", flag: true },
    expectedReceipt: { ...RECEIPT, globalId: "release:link", linkPresent: true },
  },
  {
    tool: "jira.upsert-version-remote-link-by-global-id",
    method: "POST",
    path: "version/81/remotelink/release%3Alink",
    args: {
      ...VERSION_LINK_CONTEXT,
      globalId: "release:link",
      valueNodes: [{ path: "", kind: "boolean", booleanValue: false }],
    },
    nativeBody: false,
    expectedReceipt: { ...RECEIPT, globalId: "release:link", linkPresent: true },
  },
  {
    tool: "jira.delete-version-remote-link",
    method: "DELETE",
    path: "version/81/remotelink/release%3Alink",
    args: { ...VERSION_LINK_CONTEXT, globalId: "release:link" },
    nativeBody: undefined,
    expectedReceipt: { ...RECEIPT, globalId: "release:link", linkPresent: false },
  },
  {
    tool: "jira.delete-version-remote-links",
    method: "DELETE",
    path: "version/81/remotelink",
    args: { ...VERSION_LINK_CONTEXT, confirmAll: true },
    nativeBody: undefined,
    expectedReceipt: { ...RECEIPT, globalIds: ["release:link", "other:link"], linkPresent: false },
  },
] as const;
type Selected = (typeof VERSION_LINK_MUTATION_CASES)[number];
interface VersionLinkControls {
  status: number;
  lostAck: boolean;
  denyReadback: boolean;
  absentReadback: boolean;
  throwReadback: boolean;
  omitSelf: boolean;
  omitValue: boolean;
  duplicate: boolean;
  afterWrite?: () => void;
}
interface VersionLinkCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly expect: unknown;
}
/** Jira serializes `link` raw (`@JsonRawValue`), so a row carries the stored JSON value itself. */
interface VersionLinkRow {
  name: string;
  self?: string;
  link?: CatalogJsonValue;
}
interface VersionLinkState {
  readonly links: Map<string, CatalogJsonValue>;
  readonly actor: { key: string; name: string; active: boolean };
  readonly version: { id: string; projectId: number } & typeof VERSION_LINK_SNAPSHOT;
  readonly controls: VersionLinkControls;
  writes: number;
}
function versionLinkRows(state: VersionLinkState): (VersionLinkRow | undefined)[] {
  const { controls } = state;
  const values: VersionLinkRow[] = [...state.links].map(([globalId, value]) => ({
    name: "Native link",
    ...(controls.omitSelf
      ? {}
      : {
          self: `https://proxy.invalid/context/rest/api/2/version/81/remotelink/${encodeURIComponent(globalId)}`,
        }),
    ...(controls.omitValue ? {} : { link: structuredClone(value) }),
  }));
  return controls.duplicate ? [...values, values[0]] : values;
}
function versionLinkReadbackFault(state: VersionLinkState): AtlassianWriteHttpOutcome | undefined {
  if (state.writes > 0 && state.controls.throwReadback)
    throw new Error("Synthetic independent version readback failed");
  if (state.writes > 0 && state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return undefined;
}
function versionLinkRead(state: VersionLinkState, path: string): AtlassianWriteHttpOutcome {
  const { controls } = state;
  const fault = versionLinkReadbackFault(state);
  if (fault !== undefined) return fault;
  if (path === "myself") return { ok: true, status: 200, body: state.actor };
  if (path === "project/10000")
    return {
      ok: true,
      status: 200,
      body: { id: "10000", key: "SYN", name: "Synthetic project" },
    };
  if (path === "version/81") return { ok: true, status: 200, body: state.version };
  if (path === "version/81/remotelink")
    return state.writes > 0 && controls.absentReadback
      ? { ok: false, reason: "not-found", httpStatus: 404 }
      : { ok: true, status: 200, body: { links: versionLinkRows(state) } };
  throw new TypeError("Unexpected version-link fixture read");
}
function versionLinkWrite(
  state: VersionLinkState,
  selected: Selected,
  call: VersionLinkCall,
): AtlassianWriteHttpOutcome {
  const { controls, links } = state;
  assert.equal(call.path, selected.path);
  assert.equal(call.method, selected.method);
  assert.deepEqual(call.body, selected.nativeBody);
  assert.equal(call.expect, "none");
  assert.equal(++state.writes, 1);
  if (selected.tool === "jira.delete-version-remote-links") links.clear();
  else if (selected.tool === "jira.delete-version-remote-link") links.delete("release:link");
  else links.set("release:link", structuredClone(selected.nativeBody));
  controls.afterWrite?.();
  return controls.lostAck
    ? { ok: false, reason: "timeout" }
    : { ok: true, status: controls.status, body: undefined };
}
function versionLinkState(): VersionLinkState {
  return {
    links: new Map<string, CatalogJsonValue>([
      ["release:link", { globalId: "release:link", flag: false }],
      ["other:link", null],
    ]),
    actor: { key: "synthetic-actor", name: "synthetic-user", active: true },
    version: { id: "81", projectId: 10000, ...VERSION_LINK_SNAPSHOT },
    controls: {
      status: 204,
      lostAck: false,
      denyReadback: false,
      absentReadback: false,
      throwReadback: false,
      omitSelf: false,
      omitValue: false,
      duplicate: false,
    },
    writes: 0,
  };
}
/** Independent actor, version and native link set. Returned URLs are deliberately proxy-origin
 * comparison data; the request channel can address only the selected fixed Jira resources. */
export function versionLinkMutationFixture(selected: Selected): {
  readonly request: JiraMutationRequest;
  readonly calls: VersionLinkCall[];
  readonly links: Map<string, CatalogJsonValue>;
  readonly actor: { key: string; name: string; active: boolean };
  readonly version: VersionLinkState["version"];
  readonly controls: VersionLinkControls;
  readonly writes: () => number;
  readonly snapshot: () => CatalogJsonObject;
} {
  const state = versionLinkState();
  const { links, actor, version, controls } = state;
  const calls: VersionLinkCall[] = [];
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => {
      const call = { path, method, body, expect };
      calls.push(call);
      return method === "GET"
        ? versionLinkRead(state, path)
        : versionLinkWrite(state, selected, call);
    });
  return {
    request,
    calls,
    links,
    actor,
    version,
    controls,
    writes: () => state.writes,
    snapshot: (): CatalogJsonObject => ({
      links: [...links].map(([globalId, value]) => ({ globalId, value })),
      writes: state.writes,
    }),
  };
}
