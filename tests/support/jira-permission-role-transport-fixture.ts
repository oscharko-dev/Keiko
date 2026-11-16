import { expect } from "vitest";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import {
  PERMISSION_SCHEME_MUTATION_CASES,
  permissionSchemeMutationFixture,
} from "./jira-permission-scheme-mutation-fixture.js";
import { ROLE_MUTATION_FIXTURE_CASES, roleMutationFixture } from "./jira-role-mutation-fixture.js";
import {
  reviewedPlatformTransportFixture,
  type ReviewedTransportFixture,
} from "./jira-reviewed-platform-transport-fixture.js";

/** Fixed fixture routes, including the independently selected principal query identities. */
const ROLE_READS = new Set([
  "myself",
  "role",
  "role/7",
  "role/7/actors",
  "role/9",
  "role/9/actors",
  "role/9007199254740993",
  "role/9007199254740993/actors",
  "project/SYN",
  "project/10000",
  "project/10000/role/7",
  "user?username=next-user",
  "user?key=next-key",
  "user?username=current-user",
  "user?key=current-key",
  "groups/picker?query=next-group&maxResults=100",
  "groups/picker?query=current-group&maxResults=100",
]);
const PERMISSION_READS = new Set([
  "myself",
  "permissionscheme",
  "permissionscheme/7",
  "permissionscheme/7/permission",
  "permissionscheme/9007199254740993",
  "permissionscheme/9007199254740993/permission",
  "permissionscheme/7/attribute/ADMINISTER_PROJECTS.extended.enabled",
]);
function permissionSchemeTransportFixture(
  apiRoot: string,
  selected: (typeof PERMISSION_SCHEME_MUTATION_CASES)[number],
  actorKey = "synthetic-actor",
): ReviewedTransportFixture {
  const native = permissionSchemeMutationFixture();
  native.actor.key = actorKey;
  const attribute = selected.tool === "jira.set-permission-scheme-attribute";
  const request: JiraMutationRequest = async (path, method, body, responseMode) => {
    if (attribute && method === "PUT") {
      expect(path).toBe(selected.path);
      expect(body).toBeUndefined();
      const write = native.ports.setAttribute;
      if (write === undefined) throw new TypeError("Missing synthetic fixed attribute writer");
      return write("7", "ADMINISTER_PROJECTS.extended.enabled", false);
    }
    return native.ports.request(path, method, body, responseMode);
  };
  return reviewedPlatformTransportFixture(
    apiRoot,
    {
      path: selected.path,
      method: selected.method,
      body: selected.body,
      acknowledgement: selected.method === "POST" ? "json" : "none",
      ...(attribute ? { bodyText: "false" as const } : {}),
    },
    request,
    (path) => PERMISSION_READS.has(path),
    () => native.snapshot(),
  );
}
function roleTransportFixture(
  apiRoot: string,
  selected: (typeof ROLE_MUTATION_FIXTURE_CASES)[number],
  actorKey = "synthetic-actor",
): ReviewedTransportFixture {
  const native = roleMutationFixture();
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(
    apiRoot,
    {
      path: selected.path,
      method: selected.method,
      body: selected.body,
      acknowledgement: selected.name === "jira.create-role" ? "json" : "none",
    },
    (path, method, body, responseMode) => native.request(path, method, body, responseMode),
    (path) => ROLE_READS.has(path),
    () => native.snapshot(),
  );
}
export function permissionRoleTransportController(
  operation: string | undefined,
  actorKey = "synthetic-actor",
): ReviewedTransportFixture | undefined {
  const scheme = PERMISSION_SCHEME_MUTATION_CASES.find((item) => item.tool === operation);
  if (scheme !== undefined)
    return permissionSchemeTransportFixture("/context/rest/api/2", scheme, actorKey);
  const role = ROLE_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  return role === undefined
    ? undefined
    : roleTransportFixture("/context/rest/api/2", role, actorKey);
}
