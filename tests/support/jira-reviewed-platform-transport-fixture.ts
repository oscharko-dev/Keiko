import { expect } from "vitest";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { VERSION_LINK_MUTATION_CASES, versionLinkMutationFixture } from "./jira-version-link-mutation-fixture.js";
import { PROJECT_CATEGORY_FIXTURE_CASES, projectCategoryFixture } from "./jira-project-category-fixture.js";
import { response } from "./jira-managed-remote.js";

export interface ReviewedTransportFixture {
  readonly read: (request: AtlassianHttpBodyRequest) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (request: AtlassianHttpBodyRequest) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => object;
}
interface NativeCase {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body: Parameters<JiraMutationRequest>[2];
  readonly acknowledgement: "json" | "json-array" | "none";
  readonly bodyText?: "true" | "false";
}
/** Only a bridge to independent synthetic native state, never a product dispatcher.
 * The actual serialized body must equal the fixture literal before that literal reaches the port. */
export function reviewedPlatformTransportFixture(
  apiRoot: string,
  selected: NativeCase,
  native: JiraMutationRequest,
  acceptsRead: (path: string) => boolean,
  snapshot: () => object,
): ReviewedTransportFixture {
  let writes = 0;
  return {
    snapshot,
    async read(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${apiRoot}/`)) return undefined;
      const path = url.pathname.slice(apiRoot.length + 1) + url.search;
      if (!acceptsRead(path)) return undefined;
      expect(request.method).toBe("GET");
      expect(request.bodyJson).toBeUndefined();
      expect(request.jiraExperimental).toBeUndefined();
      expect(request.jiraPermissionAttribute).toBeUndefined();
      const array = path === "projectCategory" || path === "role";
      const result = await native(path, "GET", undefined, array ? "json-array" : "json");
      return result.ok ? response(result.items ?? result.body, result.status) : response({}, result.httpStatus ?? 503);
    },
    async write(request) {
      const url = new URL(request.url);
      if (`${url.pathname}${url.search}` !== `${apiRoot}/${selected.path}`) return undefined;
      expect(request.method).toBe(selected.method);
      expect(request.jiraExperimental).toBeUndefined();
      expect(request.jiraPermissionAttribute).toBe(selected.bodyText === undefined ? undefined : true);
      const expectedBody = selected.body === undefined ? undefined : JSON.stringify(selected.body);
      expect(request.bodyJson).toBe(selected.bodyText ?? expectedBody);
      expect(++writes).toBe(1);
      const result = await native(selected.path, selected.method, selected.body, selected.acknowledgement);
      return result.ok ? response(result.items ?? result.body, result.status) : response({}, result.httpStatus ?? 503);
    },
  };
}

export function versionLinkTransportFixture(
  apiRoot: string,
  selected: (typeof VERSION_LINK_MUTATION_CASES)[number],
  actorKey = "synthetic-actor",
): ReviewedTransportFixture {
  const native = versionLinkMutationFixture(selected);
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(apiRoot, { path: selected.path, method: selected.method,
    body: selected.nativeBody, acknowledgement: "none" }, native.request,
  (path) => path === "myself" || path === "project/10000" || path === "version/81" || path === "version/81/remotelink",
  native.snapshot);
}

export function projectCategoryTransportFixture(
  apiRoot: string,
  selected: (typeof PROJECT_CATEGORY_FIXTURE_CASES)[number],
  actorKey = "synthetic-actor",
): ReviewedTransportFixture {
  const native = projectCategoryFixture();
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(apiRoot, { path: selected.path.slice("/rest/api/2/".length), method: selected.method,
    body: selected.body, acknowledgement: selected.method === "DELETE" ? "none" : "json" }, native.request,
  (path) => path === "myself" || path === "projectCategory" || path === "projectCategory/7" || path === "projectCategory/9007199254740993",
  native.snapshot);
}
