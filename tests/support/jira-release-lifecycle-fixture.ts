import { expect } from "vitest";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

export const RELEASE_FIXTURE_ACTOR = { key: "synthetic-actor", name: "synthetic-user" };
export const RELEASE_FIXTURE_PROJECT = { id: "10000", key: "SYN", name: "Synthetic project" };
export const RELEASE_FIXTURE_VERSION = { name: "Reviewed release", description: "", startDate: null, releaseDate: null, released: false, archived: false };
export const RELEASE_FIXTURE_COMPONENT = { name: "Reviewed component", description: "", leadUserName: null, assigneeType: null, archived: false, deleted: false };
export const RELEASE_FIXTURE_BASE = { expectedProjectId: "10000", expectedActorKey: "synthetic-actor" };
export const RELEASE_LIFECYCLE_FIXTURE_CASES = [
  { tool: "jira.delete-component", method: "DELETE", path: "/component/71", query: "?moveIssuesTo=72", expectedOutcome: "succeeded-unconfirmed",
    args: { ...RELEASE_FIXTURE_BASE, componentId: "71", expectedComponentSnapshot: RELEASE_FIXTURE_COMPONENT, moveIssuesTo: "72", expectedReplacementSnapshot: { ...RELEASE_FIXTURE_COMPONENT, name: "Retained component" } } },
  { tool: "jira.merge-version", method: "PUT", path: "/version/81/mergeto/82", query: "", expectedOutcome: "succeeded-unconfirmed",
    args: { ...RELEASE_FIXTURE_BASE, versionId: "81", expectedVersionSnapshot: RELEASE_FIXTURE_VERSION, moveIssuesTo: "82", expectedTargetSnapshot: { ...RELEASE_FIXTURE_VERSION, name: "Retained release" } } },
  { tool: "jira.move-version", method: "POST", path: "/version/81/move", query: "", expectedOutcome: "succeeded",
    args: { ...RELEASE_FIXTURE_BASE, versionId: "81", expectedVersionSnapshot: RELEASE_FIXTURE_VERSION, expectedVersionIds: ["81", "82"], afterVersionId: "82" } },
  { tool: "jira.remove-and-swap-version", method: "POST", path: "/version/81/removeAndSwap", query: "", expectedOutcome: "succeeded-unconfirmed",
    args: { ...RELEASE_FIXTURE_BASE, versionId: "81", expectedVersionSnapshot: RELEASE_FIXTURE_VERSION, moveFixIssuesTo: "82", moveAffectedIssuesTo: null,
      customFieldReplacementList: [{ customFieldId: "10001", moveTo: "82" }], expectedReplacementVersions: [{ versionId: "82", expectedVersionSnapshot: { ...RELEASE_FIXTURE_VERSION, name: "Retained release" } }] } },
] as const;

/** Independent native HTTP fixtures for the primary-wire suite. Not registered until the owner
 * adds these four closed operations. All paths use a selected connection's context root. */
export function releaseLifecycleTransportFixture(apiRoot: string): {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => { readonly versionIds: readonly string[]; readonly componentIds: readonly string[] };
} {
  const version = { id: "81", projectId: 10000, ...RELEASE_FIXTURE_VERSION };
  const target = { id: "82", projectId: 10000, ...RELEASE_FIXTURE_VERSION, name: "Retained release" };
  const component = { id: "71", project: "SYN", name: RELEASE_FIXTURE_COMPONENT.name, description: "", archived: false, deleted: false };
  const replacement = { ...component, id: "72", name: "Retained component" };
  let versions = [version, target];
  let components = [component, replacement];
  return {
    snapshot: () => ({ versionIds: versions.map((item) => item.id), componentIds: components.map((item) => item.id) }),
    read(request) {
      const url = new URL(request.url);
      if (url.pathname === `${apiRoot}/myself`) return response(RELEASE_FIXTURE_ACTOR);
      if (url.pathname === `${apiRoot}/project/10000`) return response(RELEASE_FIXTURE_PROJECT);
      if (url.pathname === `${apiRoot}/project/10000/versions`) return response(versions);
      if (url.pathname === `${apiRoot}/project/10000/components`) return response(components);
      if (url.pathname === `${apiRoot}/version/81`) return response(version);
      if (url.pathname === `${apiRoot}/version/82`) return response(target);
      if (url.pathname === `${apiRoot}/component/71`) return response(component);
      if (url.pathname === `${apiRoot}/component/72`) return response(replacement);
      if (url.pathname === `${apiRoot}/field`) return response([{ id: "customfield_10001", schema: { type: "array", items: "version", customId: 10001 } }]);
      return undefined;
    },
    write(request) {
      const url = new URL(request.url);
      if (url.pathname === `${apiRoot}/component/71`) {
        expect(request.method).toBe("DELETE");
        expect(url.search).toBe("?moveIssuesTo=72");
        expect(request.bodyJson).toBeUndefined();
        components = [replacement];
      } else if (url.pathname === `${apiRoot}/version/81/mergeto/82`) {
        expect(request.method).toBe("PUT");
        expect(url.search).toBe("");
        expect(request.bodyJson).toBeUndefined();
        versions = [target];
      } else if (url.pathname === `${apiRoot}/version/81/move`) {
        expect(request.method).toBe("POST");
        expect(url.search).toBe("");
        expect(request.bodyJson).toBe(JSON.stringify({ after: `${url.origin}${apiRoot}/version/82` }));
        versions = [target, version];
      } else if (url.pathname === `${apiRoot}/version/81/removeAndSwap`) {
        expect(request.method).toBe("POST");
        expect(url.search).toBe("");
        expect(request.bodyJson).toBe(JSON.stringify({ moveFixIssuesTo: 82, moveAffectedIssuesTo: null, customFieldReplacementList: [{ customFieldId: 10001, moveTo: 82 }] }));
        versions = [target];
      } else return undefined;
      return response(undefined, 204);
    },
  };
}
