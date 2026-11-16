import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { settleSync } from "./jira-fixture-settle.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraReciprocalConfigurationPorts } from "../../packages/keiko-connectors/src/jira-reciprocal-configuration-request.js";

export const RECIPROCAL_ARGUMENTS = {
  expectedActorKey: "synthetic-actor",
  expectedIssue: {
    id: "10001",
    key: "SYN-1",
    summary: "Local reviewed issue",
    projectId: "10000",
    issueTypeId: "3",
  },
  expectedApplication: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Configured remote Jira",
    displayUrl: "https://remote.example.invalid/jira",
    rpcUrl: "https://rpc.example.invalid/jira",
  },
  remoteIssueId: "9223372036854775807",
  remoteIssueTitle: "Selected remote issue",
  sourceRelationship: "relates to",
  targetRelationship: "is related from",
  expectLocalLinkAbsent: true,
  acceptNativeDelegatedEffect: true,
} as const;
export const RECIPROCAL_NATIVE_BODY = {
  source: {
    application: { type: "com.atlassian.jira", name: "Configured remote Jira" },
    globalId: "appId=22222222-2222-4222-8222-222222222222&issueId=9223372036854775807",
    relationship: "relates to",
    object: {
      url: "https://remote.example.invalid/jira/browse/9223372036854775807",
      title: "Selected remote issue",
    },
  },
  target: {
    application: { type: "com.atlassian.jira", name: "Local Jira" },
    globalId: "appId=11111111-1111-4111-8111-111111111111&issueId=10001",
    relationship: "is related from",
    object: {
      url: "https://local.example.invalid/context/browse/10001",
      title: "SYN-1",
      summary: "Local reviewed issue",
    },
  },
} as const;
interface ReciprocalControls {
  lostAck: boolean;
  reject: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  actorChanged: boolean;
  existing: boolean;
  omitLocalEffect: boolean;
  configChanges: boolean;
  manifestChanges: boolean;
}
interface ReciprocalCall {
  path: string;
  method: string;
  body: unknown;
  expect: unknown;
}
interface ReciprocalState {
  readonly actor: { key: string; name: string };
  readonly manifest: Record<string, unknown>;
  readonly application: Record<string, unknown>;
  readonly row: {
    application: Record<string, unknown>;
    appLinkState: string;
    hasIncomingAuthenticationProviders: boolean;
    hasOutgoingAuthenticationProviders: boolean;
  };
  readonly controls: ReciprocalControls;
  readonly calls: ReciprocalCall[];
  readonly linked: Record<string, unknown>;
  effects: number;
  configReads: number;
  manifestReads: number;
}
function reciprocalState(): ReciprocalState {
  const application: Record<string, unknown> = {
    ...RECIPROCAL_ARGUMENTS.expectedApplication,
    typeId: "jira",
  };
  return {
    actor: { key: "synthetic-actor", name: "operator" },
    manifest: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Local Jira",
      typeId: "jira",
    },
    application,
    row: {
      application,
      appLinkState: "OK",
      hasIncomingAuthenticationProviders: true,
      hasOutgoingAuthenticationProviders: true,
    },
    controls: {
      lostAck: false,
      reject: false,
      denyReadback: false,
      throwReadback: false,
      actorChanged: false,
      existing: false,
      omitLocalEffect: false,
      configChanges: false,
      manifestChanges: false,
    },
    calls: [],
    linked: { id: 51, ...RECIPROCAL_NATIVE_BODY.source },
    effects: 0,
    configReads: 0,
    manifestReads: 0,
  };
}
function reciprocalPost(
  state: ReciprocalState,
  path: string,
  body: unknown,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  const { controls } = state;
  assert.equal(path, "issue/remotelink/reciprocal");
  assert.equal(expect, "json");
  assert.deepEqual(body, RECIPROCAL_NATIVE_BODY);
  assert.equal(++state.effects, 1);
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  if (controls.reject) return { ok: false, reason: "field-validation", httpStatus: 400 };
  return { ok: true, status: 200, body: { source: {}, target: {} } };
}
function reciprocalGet(
  state: ReciprocalState,
  path: string,
  expect: unknown,
): AtlassianWriteHttpOutcome {
  const { actor, controls, linked } = state;
  if (path === "myself")
    return {
      ok: true,
      status: 200,
      body: { ...actor, key: controls.actorChanged ? "other-actor" : actor.key },
    };
  if (path === "issue/10001?fields=issuetype%2Cproject%2Csummary")
    return {
      ok: true,
      status: 200,
      body: {
        id: "10001",
        key: "SYN-1",
        fields: {
          summary: "Local reviewed issue",
          project: { id: "10000" },
          issuetype: { id: "3" },
        },
      },
    };
  assert.equal(path, "issue/10001/remotelink");
  assert.equal(expect, "json-array");
  return {
    ok: true,
    status: 200,
    body: undefined,
    items:
      controls.existing || (state.effects > 0 && !controls.omitLocalEffect)
        ? [structuredClone(linked)]
        : [],
  };
}
function reciprocalRequest(
  state: ReciprocalState,
  call: ReciprocalCall,
): AtlassianWriteHttpOutcome {
  const { path, method, body, expect } = call;
  const { controls } = state;
  if (state.effects > 0 && controls.throwReadback)
    throw new Error("Synthetic reciprocal readback failure");
  if (state.effects > 0 && controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (method === "POST") return reciprocalPost(state, path, body, expect);
  assert.equal(method, "GET");
  return reciprocalGet(state, path, expect);
}
function reciprocalManifest(state: ReciprocalState): AtlassianWriteHttpOutcome {
  state.calls.push({
    path: "/rest/applinks/1.0/manifest",
    method: "GET",
    body: undefined,
    expect: "json",
  });
  return {
    ok: true,
    status: 200,
    body: {
      ...state.manifest,
      ...(state.controls.manifestChanges && ++state.manifestReads > 1
        ? { id: "33333333-3333-4333-8333-333333333333" }
        : {}),
    },
  };
}
function reciprocalApplicationLinks(state: ReciprocalState): AtlassianWriteHttpOutcome {
  state.calls.push({
    path: "/rest/applinks/1.0/listApplicationlinks",
    method: "GET",
    body: undefined,
    expect: "json",
  });
  return {
    ok: true,
    status: 200,
    body: {
      list: [
        {
          ...state.row,
          application: {
            ...state.application,
            ...(state.controls.configChanges && ++state.configReads > 1
              ? { rpcUrl: "https://changed.example.invalid/jira" }
              : {}),
          },
        },
      ],
    },
  };
}
function reciprocalPorts(state: ReciprocalState): JiraReciprocalConfigurationPorts {
  return {
    baseUrl: "https://local.example.invalid/context",
    manifest: () => settleSync(() => reciprocalManifest(state)),
    applicationLinks: () => settleSync(() => reciprocalApplicationLinks(state)),
  };
}
export function reciprocalLinkFixture(): {
  readonly request: JiraMutationRequest;
  readonly ports: JiraReciprocalConfigurationPorts;
  readonly actor: { key: string; name: string };
  readonly manifest: Record<string, unknown>;
  readonly application: Record<string, unknown>;
  readonly row: ReciprocalState["row"];
  readonly controls: ReciprocalControls;
  readonly calls: ReciprocalCall[];
  readonly snapshot: () => CatalogJsonObject;
} {
  const state = reciprocalState();
  const { actor, manifest, application, row, controls, calls } = state;
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => {
      calls.push({ path, method, body: structuredClone(body), expect });
      return reciprocalRequest(state, { path, method, body, expect });
    });
  return {
    request,
    ports: reciprocalPorts(state),
    actor,
    manifest,
    application,
    row,
    controls,
    calls,
    snapshot: (): CatalogJsonObject => ({
      effects: state.effects,
      localLinkObserved: state.effects > 0 && !controls.omitLocalEffect,
    }),
  };
}
