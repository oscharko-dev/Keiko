import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import {
  DIRECTORY_ACCESS_FIXTURE_CASES,
  directoryAccessFixture,
} from "./jira-directory-access-fixture.js";
import {
  MAINTENANCE_MUTATION_FIXTURE_CASES,
  maintenanceMutationFixture,
} from "./jira-maintenance-mutation-fixture.js";
import {
  SCHEMA_MUTATION_FIXTURE_CASES,
  schemaMutationFixture,
} from "./jira-schema-mutation-fixture.js";
import {
  GROUP_MUTATION_FIXTURE_CASES,
  groupMutationFixture,
} from "./jira-group-mutation-fixture.js";
import { ISSUE_ACTION_FIXTURE_CASES, issueActionFixture } from "./jira-issue-action-fixture.js";
import { reviewedPlatformTransportFixture } from "./jira-reviewed-platform-transport-fixture.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { response } from "./jira-managed-remote.js";
import type { ReviewedTransportFixture } from "./jira-reviewed-platform-transport-fixture.js";

const ROOT = "/context/rest/api/2";
const DIRECTORY_READS = new Set([
  "myself",
  "applicationrole",
  "applicationrole/jira-software",
  "user?username=Target+User",
  "user?key=target-user",
  "user/columns?username=Target+User",
  "groups/picker?query=jira-users&maxResults=100",
  "groups/picker?query=R%26D+team&maxResults=100",
]);
const MAINTENANCE_READS = new Set([
  "myself",
  "cluster/nodes",
  "cluster/zdu/state",
  "index-snapshot/isRunning",
  "reindex",
  "upgrade",
  "issue/10001?fields=summary",
  "issue/9223372036854775807?fields=summary",
  "reindex/request/bulk?requestId=7&requestId=9223372036854775807",
]);
const SCHEMA_READS = new Set([
  "myself",
  "project/10000",
  "field",
  "terminology/entries",
  "issuetype",
  "issuetype/1",
  "issuetype/2",
  "issuetype/1/alternatives",
  "issuetype/9007199254740993",
  "issueLinkType",
  "issueLinkType/7",
  "issueLinkType/8",
  "issueLinkType/9007199254740993",
]);
const GROUP_READS = new Set([
  "myself",
  "user?username=Target+User",
  "user?key=target-key",
  "groups/picker?query=R%26D+team&maxResults=100",
  "groups/picker?query=Replacement&maxResults=100",
  "groups/picker?query=New+%26+Group&maxResults=100",
  "group/member?groupname=R%26D+team&includeInactiveUsers=true&startAt=0&maxResults=50",
]);
const ISSUE_READS = new Set([
  "myself",
  "user?username=Recipient+User",
  "user?key=recipient-key",
  "issue/SYN-1?fields=summary",
  "issue/10001?fields=summary",
  "issue/10001/comment/9007199254740993",
  "issue/10001/pinned-comments",
]);
type DirectoryCase = (typeof DIRECTORY_ACCESS_FIXTURE_CASES)[number];
type DirectoryNative = ReturnType<typeof directoryAccessFixture>;

function isRoleCas(selected: DirectoryCase): boolean {
  return (
    selected.name === "jira.set-application-role" || selected.name === "jira.set-application-roles"
  );
}
function directoryReadPath(request: AtlassianHttpBodyRequest): string | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${ROOT}/`)) return undefined;
  const path = url.pathname.slice(ROOT.length + 1) + url.search;
  return DIRECTORY_READS.has(path) ? path : undefined;
}
async function directoryRead(
  native: DirectoryNative,
  selected: DirectoryCase,
  request: AtlassianHttpBodyRequest,
): Promise<AtlassianHttpBodyResult | undefined> {
  const path = directoryReadPath(request);
  if (path === undefined) return undefined;
  expect(request.method).toBe("GET");
  expect(request.bodyJson).toBeUndefined();
  // Only the two role-CAS operations request the private version, ordinary role reads do not.
  const cas = isRoleCas(selected);
  expect(request.jiraApplicationRole).toBe(
    path === "applicationrole" && cas ? "version" : undefined,
  );
  const result = await native.request(
    path,
    "GET",
    undefined,
    path === "applicationrole" || path.startsWith("user/columns?") ? "json-array" : "json",
  );
  return directoryReadResult(result, path === "applicationrole" && cas);
}
function directoryReadResult(
  result: Awaited<ReturnType<DirectoryNative["request"]>>,
  versioned: boolean,
): AtlassianHttpBodyResult {
  if (!result.ok) return response({}, result.httpStatus ?? 503);
  return {
    ...response(result.items ?? result.body, result.status),
    ...(versioned && result.applicationRoleVersion !== undefined
      ? { applicationRoleVersion: result.applicationRoleVersion }
      : {}),
  };
}
function expectDirectoryWriteFlags(
  selected: DirectoryCase,
  request: AtlassianHttpBodyRequest,
  body: Parameters<JiraMutationRequest>[2],
): void {
  const application =
    selected.name === "jira.add-user-application" ||
    selected.name === "jira.remove-user-application";
  const form = selected.name === "jira.set-user-columns";
  expect(request.jiraApplicationRole).toEqual(
    isRoleCas(selected) ? { ifMatch: '"native-role-version"' } : undefined,
  );
  expect(request.jiraUserApplication).toBe(application ? true : undefined);
  expect(request.jiraUserColumns).toBe(form ? true : undefined);
  expect(request.bodyJson).toBe(
    form ? body : body === undefined ? undefined : JSON.stringify(body),
  );
}
function checkDirectoryWrite(
  selected: DirectoryCase,
  request: AtlassianHttpBodyRequest,
): Parameters<JiraMutationRequest>[2] {
  expect(request.method).toBe(selected.method);
  expect(request.jiraExperimental).toBeUndefined();
  expect(request.jiraPermissionAttribute).toBeUndefined();
  expect(request.jiraEmailTemplateArchive).toBeUndefined();
  expect(request.upload).toBeUndefined();
  const body = "body" in selected ? selected.body : undefined;
  expectDirectoryWriteFlags(selected, request, body);
  return body;
}
/** Raw form and private ETag flags are asserted at the same HTTP boundary as actual gateway requests. */
function directoryController(selected: DirectoryCase, actorKey: string): ReviewedTransportFixture {
  const native = directoryAccessFixture(selected);
  native.actor.key = actorKey;
  let writes = 0;
  return {
    snapshot: () => native.snapshot(),
    read: (request) => directoryRead(native, selected, request),
    async write(request): Promise<AtlassianHttpBodyResult | undefined> {
      const url = new URL(request.url);
      if (`${url.pathname}${url.search}` !== `${ROOT}/${selected.path}`) return undefined;
      const body = checkDirectoryWrite(selected, request);
      expect(++writes).toBe(1);
      const result = await native.request(selected.path, selected.method, body, "none");
      return result.ok
        ? response(undefined, result.status)
        : response({}, result.httpStatus ?? 503);
    },
  };
}
function schemaController(
  selected: (typeof SCHEMA_MUTATION_FIXTURE_CASES)[number],
  actorKey: string,
): ReviewedTransportFixture {
  const native = schemaMutationFixture();
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(
    ROOT,
    { ...selected, acknowledgement: "create" in selected ? "json" : "none" },
    native.request,
    (path) => SCHEMA_READS.has(path),
    () => ({
      types: [...native.types.values()],
      links: [...native.links.values()],
      fields: [...native.fields.values()],
      terms: structuredClone(native.terms),
    }),
  );
}
/** Independent cases and explicit read allowlists; no target or expected state derives from registry/producer output. */
export function systemAdministrationTransportController(
  operation: string | undefined,
  actorKey = "synthetic-actor",
): ReviewedTransportFixture | undefined {
  const directory = DIRECTORY_ACCESS_FIXTURE_CASES.find((item) => item.name === operation);
  if (directory !== undefined) return directoryController(directory, actorKey);
  const maintenance = MAINTENANCE_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  if (maintenance !== undefined) {
    const native = maintenanceMutationFixture(maintenance);
    native.actor.key = actorKey;
    return reviewedPlatformTransportFixture(
      ROOT,
      {
        ...maintenance,
        body: undefined,
        acknowledgement:
          maintenance.name === "jira.process-reindex-requests" ? "json-array" : "none",
      },
      native.request,
      (path) => MAINTENANCE_READS.has(path),
      () => native.snapshot(),
    );
  }
  const schema = SCHEMA_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  if (schema !== undefined) return schemaController(schema, actorKey);
  const group = GROUP_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  if (group !== undefined) {
    const native = groupMutationFixture(group.name === "jira.remove-group-user");
    native.controls.actorKey = actorKey;
    return reviewedPlatformTransportFixture(
      ROOT,
      { ...group, acknowledgement: group.name === "jira.create-group" ? "json" : "none" },
      native.request,
      (path) => GROUP_READS.has(path),
      () => native.snapshot(),
    );
  }
  const issue = ISSUE_ACTION_FIXTURE_CASES.find((item) => item.name === operation);
  if (issue === undefined) return undefined;
  const native = issueActionFixture();
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(
    ROOT,
    { ...issue, acknowledgement: "none" },
    native.request,
    (path) => ISSUE_READS.has(path),
    () => ({ effects: native.effects(), pinned: native.controls.pinned }),
  );
}
