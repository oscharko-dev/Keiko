import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
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
export function reciprocalLinkFixture() {
  const actor = { key: "synthetic-actor", name: "operator" };
  const manifest: Record<string, unknown> = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Local Jira",
    typeId: "jira",
  };
  const application: Record<string, unknown> = {
    ...RECIPROCAL_ARGUMENTS.expectedApplication,
    typeId: "jira",
  };
  const row = {
    application,
    appLinkState: "OK",
    hasIncomingAuthenticationProviders: true,
    hasOutgoingAuthenticationProviders: true,
  };
  const controls = {
    lostAck: false,
    reject: false,
    denyReadback: false,
    throwReadback: false,
    actorChanged: false,
    existing: false,
    omitLocalEffect: false,
    configChanges: false,
    manifestChanges: false,
  };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  let effects = 0;
  let configReads = 0;
  let manifestReads = 0;
  const linked = { id: 51, ...RECIPROCAL_NATIVE_BODY.source };
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (effects > 0 && controls.throwReadback)
      throw new Error("Synthetic reciprocal readback failure");
    if (effects > 0 && controls.denyReadback)
      return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (method === "POST") {
      assert.equal(path, "issue/remotelink/reciprocal");
      assert.equal(expect, "json");
      assert.deepEqual(body, RECIPROCAL_NATIVE_BODY);
      assert.equal(++effects, 1);
      if (controls.lostAck) return { ok: false, reason: "timeout" };
      if (controls.reject) return { ok: false, reason: "field-validation", httpStatus: 400 };
      return { ok: true, status: 200, body: { source: {}, target: {} } };
    }
    assert.equal(method, "GET");
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
        controls.existing || (effects > 0 && !controls.omitLocalEffect)
          ? [structuredClone(linked)]
          : [],
    };
  };
  const ports: JiraReciprocalConfigurationPorts = {
    baseUrl: "https://local.example.invalid/context",
    manifest: async () => {
      calls.push({
        path: "/rest/applinks/1.0/manifest",
        method: "GET",
        body: undefined,
        expect: "json",
      });
      return {
        ok: true,
        status: 200,
        body: {
          ...manifest,
          ...(controls.manifestChanges && ++manifestReads > 1
            ? { id: "33333333-3333-4333-8333-333333333333" }
            : {}),
        },
      };
    },
    applicationLinks: async () => {
      calls.push({
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
              ...row,
              application: {
                ...application,
                ...(controls.configChanges && ++configReads > 1
                  ? { rpcUrl: "https://changed.example.invalid/jira" }
                  : {}),
              },
            },
          ],
        },
      };
    },
  };
  return {
    request,
    ports,
    actor,
    manifest,
    application,
    row,
    controls,
    calls,
    snapshot: (): CatalogJsonObject => ({
      effects,
      localLinkObserved: effects > 0 && !controls.omitLocalEffect,
    }),
  };
}
