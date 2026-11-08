import { expect } from "vitest";
import { createHash } from "node:crypto";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import {
  PROJECT_LIFECYCLE_FIXTURE_CASES,
  projectLifecycleFixture,
} from "./jira-project-lifecycle-fixture.js";
import {
  ISSUE_LIFECYCLE_FIXTURE_CASES,
  issueLifecycleFixture,
} from "./jira-issue-lifecycle-fixture.js";
import {
  BULK_CREATE_ARGUMENTS,
  BULK_CREATE_RECEIPT,
  bulkCreateFixture,
} from "./jira-bulk-create-fixture.js";
import {
  RECIPROCAL_ARGUMENTS,
  RECIPROCAL_NATIVE_BODY,
  reciprocalLinkFixture,
} from "./jira-reciprocal-link-fixture.js";
import { response } from "./jira-managed-remote.js";

const ROOT = "/context/rest/api/2";
const APP_LINKS_ROOT = "/context/rest/applinks/1.0";
const ISSUE_READ = "issue/10001?fields=issuetype%2Cproject%2Csummary";
const OTHER_ISSUE_READ = "issue/9223372036854775807?fields=issuetype%2Cproject%2Csummary";
type Expectation = NonNullable<Parameters<JiraMutationRequest>[3]>;
const PROJECT_READS: Readonly<Record<string, Expectation>> = {
  myself: "json",
  "project/10000": "json",
  "project/type/business/accessible": "json",
  "project/10000/permissionscheme": "json",
  "project/10000/priorityscheme": "json",
  "permissionscheme/7": "json",
  "permissionscheme/7/permission": "json",
  "permissionscheme/8": "json",
  "permissionscheme/8/permission": "json",
  "priorityschemes/9": "json",
  "priorityschemes/10": "json",
};
const ISSUE_READS: Readonly<Record<string, Expectation>> = {
  myself: "json",
  [ISSUE_READ]: "json",
  [OTHER_ISSUE_READ]: "json",
  "issue/10001/subtask": "json-array",
  "issue/10001/subtask/move": "json-scalar",
};
const BULK_READS: Readonly<Record<string, Expectation>> = {
  myself: "json",
  "project/10000": "json",
  "issuetype/3": "json",
  "issue/createmeta/10000/issuetypes/3?startAt=0&maxResults=100": "json",
  [ISSUE_READ]: "json",
  [OTHER_ISSUE_READ]: "json",
};
const RECIPROCAL_READS: Readonly<Record<string, Expectation>> = {
  myself: "json",
  [ISSUE_READ]: "json",
  "issue/10001/remotelink": "json-array",
};
/** Independent literal body: the real bulk executor still calls prepareJiraCreate and reads
 * native metadata for every item before this one HTTP effect can match. */
export const BULK_CREATE_NATIVE_BODY = {
  issueUpdates: [
    {
      fields: { summary: "First reviewed issue", project: { id: "10000" }, issuetype: { id: "3" } },
      update: {},
    },
    {
      fields: {
        summary: "Second reviewed issue",
        project: { id: "10000" },
        issuetype: { id: "3" },
      },
      update: {},
    },
  ],
} as const;

interface TransportController {
  readonly read: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => object;
}
interface NativeCase {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body: Parameters<JiraMutationRequest>[2];
  readonly acknowledgement: Expectation;
}
function relativePath(request: AtlassianHttpBodyRequest, root = ROOT): string | undefined {
  const url = new URL(request.url);
  return url.pathname.startsWith(`${root}/`)
    ? url.pathname.slice(root.length + 1) + url.search
    : undefined;
}
function projectPriorityPath(path: string): boolean {
  return path === "project/10000/priorityscheme" || path === "project/10000/priorityscheme/9";
}
function requestFlags(request: AtlassianHttpBodyRequest, priority = false): void {
  expect(request.jiraProjectPriority).toBe(priority ? true : undefined);
  expect(request.jiraExperimental).toBeUndefined();
  expect(request.jiraPermissionAttribute).toBeUndefined();
  expect(request.jiraEmailTemplateArchive).toBeUndefined();
  expect(request.jiraApplicationRole).toBeUndefined();
  expect(request.jiraUserApplication).toBeUndefined();
  expect(request.jiraUserColumns).toBeUndefined();
  expect(request.jiraIdentityExperimental).toBeUndefined();
  expect(request.jiraHumanInput).toBeUndefined();
  expect(request.jiraAvatarImage).toBeUndefined();
  expect(request.upload).toBeUndefined();
}
function nativeResponse(result: Awaited<ReturnType<JiraMutationRequest>>): AtlassianHttpBodyResult {
  if (!result.ok) return response({}, result.httpStatus ?? 503);
  const value = result.scalar === undefined ? (result.items ?? result.body) : result.scalar;
  return response(value, result.status);
}
function platformController(
  selected: NativeCase,
  native: JiraMutationRequest,
  reads: Readonly<Record<string, Expectation>>,
  snapshot: () => object,
): TransportController {
  let writes = 0;
  return {
    snapshot,
    async read(request) {
      const path = relativePath(request);
      if (path === undefined || !Object.hasOwn(reads, path)) return undefined;
      const codec = reads[path];
      if (codec === undefined) return undefined;
      expect(request.method).toBe("GET");
      expect(request.bodyJson).toBeUndefined();
      requestFlags(request, projectPriorityPath(path));
      return nativeResponse(await native(path, "GET", undefined, codec));
    },
    async write(request) {
      if (relativePath(request) !== selected.path) return undefined;
      expect(request.method).toBe(selected.method);
      requestFlags(request, projectPriorityPath(selected.path));
      expect(request.bodyJson).toBe(
        selected.body === undefined ? undefined : JSON.stringify(selected.body),
      );
      expect(++writes).toBe(1);
      return nativeResponse(
        await native(selected.path, selected.method, selected.body, selected.acknowledgement),
      );
    },
  };
}
function reciprocalController(actorKey: string, baseUrl: string): TransportController {
  const native = reciprocalLinkFixture();
  native.actor.key = actorKey;
  // Only the fixture's known LOCAL saved connection is rebound. Remote destinations and both
  // native relationship directions remain independent literals, never copied from a request.
  const expectedBody = {
    ...RECIPROCAL_NATIVE_BODY,
    target: {
      ...RECIPROCAL_NATIVE_BODY.target,
      object: { ...RECIPROCAL_NATIVE_BODY.target.object, url: `${baseUrl}/browse/10001` },
    },
  };
  const local = platformController(
    {
      path: "issue/remotelink/reciprocal",
      method: "POST",
      body: expectedBody,
      acknowledgement: "json",
    },
    async (path, method, body, codec) =>
      native.request(path, method, method === "POST" ? RECIPROCAL_NATIVE_BODY : body, codec),
    RECIPROCAL_READS,
    native.snapshot,
  );
  return {
    snapshot: native.snapshot,
    write: local.write,
    async read(request) {
      const configuration = relativePath(request, APP_LINKS_ROOT);
      if (configuration !== "manifest" && configuration !== "listApplicationlinks")
        return local.read(request);
      expect(request.method).toBe("GET");
      expect(request.bodyJson).toBeUndefined();
      requestFlags(request);
      return nativeResponse(
        await (configuration === "manifest"
          ? native.ports.manifest()
          : native.ports.applicationLinks()),
      );
    },
  };
}
function controller(
  operation: string | undefined,
  actorKey: string,
  baseUrl: string,
): TransportController | undefined {
  const project = PROJECT_LIFECYCLE_FIXTURE_CASES.find((item) => item.name === operation);
  if (project !== undefined) {
    const native = projectLifecycleFixture(project);
    native.actor.key = actorKey;
    return platformController(
      { ...project, body: "body" in project ? project.body : undefined, acknowledgement: "none" },
      native.request,
      PROJECT_READS,
      native.snapshot,
    );
  }
  const issue = ISSUE_LIFECYCLE_FIXTURE_CASES.find((item) => item.name === operation);
  if (issue !== undefined) {
    const native = issueLifecycleFixture(issue);
    native.actor.key = actorKey;
    return platformController(
      { ...issue, body: "body" in issue ? issue.body : undefined, acknowledgement: "none" },
      native.request,
      ISSUE_READS,
      native.snapshot,
    );
  }
  if (operation === "jira.create-issues") {
    const native = bulkCreateFixture();
    native.actor.key = actorKey;
    return platformController(
      {
        path: "issue/bulk",
        method: "POST",
        body: BULK_CREATE_NATIVE_BODY,
        acknowledgement: "json",
      },
      native.request,
      BULK_READS,
      native.snapshot,
    );
  }
  return operation === "jira.create-reciprocal-remote-link"
    ? reciprocalController(actorKey, baseUrl)
    : undefined;
}
async function nativeRequest(
  selected: TransportController,
  request: Request,
): Promise<AtlassianHttpBodyResult | undefined> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "DELETE")
    return undefined;
  const path = relativePath({ method, url: request.url, timeoutMs: 1000, maxBodyBytes: 262144 });
  const priority = path !== undefined && projectPriorityPath(path);
  expect(request.headers.get("X-ExperimentalApi")).toBe(priority ? "true" : null);
  const body = method === "GET" ? "" : await request.clone().text();
  const input: AtlassianHttpBodyRequest = {
    method,
    url: request.url,
    timeoutMs: 1000,
    maxBodyBytes: 262144,
    ...(priority ? { jiraProjectPriority: true } : {}),
    ...(body.length === 0 ? {} : { bodyJson: body }),
  };
  return method === "GET" ? selected.read(input) : selected.write(input);
}
/** Fixed routes, literal bodies, native JSON/array/scalar acknowledgements and independent state.
 * The returned Request handler checks the real experimental header; read/write also compose with
 * the existing gateway fixture. No preparation, permission or formal-rule owner is stubbed here. */
export function projectIssueTransportController(
  operation: string | undefined,
  actorKey = "synthetic-actor",
  baseUrl = "https://local.example.invalid/context",
) {
  const selected = controller(operation, actorKey, baseUrl);
  return selected === undefined
    ? undefined
    : {
        ...selected,
        handle: (request: Request) => nativeRequest(selected, request),
      };
}

type ProjectIssueOperation =
  | (typeof PROJECT_LIFECYCLE_FIXTURE_CASES)[number]["name"]
  | (typeof ISSUE_LIFECYCLE_FIXTURE_CASES)[number]["name"]
  | "jira.create-issues"
  | "jira.create-reciprocal-remote-link";
const GATEWAY_ACTOR = "synthetic-key";
const PROJECT_URL = "https://203.0.113.10/context/projects/SYN/summary";
const ISSUE_URL = "https://203.0.113.10/context/browse/SYN-1";
/** Fixture snapshots are literal native review inputs, with only the gateway's actor rebound. */
export const PROJECT_ISSUE_ARGUMENTS: Readonly<Record<ProjectIssueOperation, CatalogJsonObject>> = {
  "jira.delete-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[0].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.archive-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[1].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.restore-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[2].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.update-project-type": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[3].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.set-project-permission-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[4].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.set-project-priority-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[5].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.remove-project-priority-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[6].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.archive-issues": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[0].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.delete-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[1].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.archive-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[2].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.restore-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[3].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.move-subtask": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[4].args,
    expectedActorKey: GATEWAY_ACTOR,
  },
  "jira.create-issues": { ...BULK_CREATE_ARGUMENTS, expectedActorKey: GATEWAY_ACTOR },
  "jira.create-reciprocal-remote-link": {
    ...RECIPROCAL_ARGUMENTS,
    expectedActorKey: GATEWAY_ACTOR,
  },
};
export const PROJECT_ISSUE_RECEIPTS: Readonly<Record<ProjectIssueOperation, CatalogJsonObject>> = {
  "jira.delete-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[0].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.archive-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[1].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.restore-project": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[2].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.update-project-type": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[3].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.set-project-permission-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[4].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.set-project-priority-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[5].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.remove-project-priority-scheme": {
    ...PROJECT_LIFECYCLE_FIXTURE_CASES[6].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: PROJECT_URL,
  },
  "jira.archive-issues": { ...ISSUE_LIFECYCLE_FIXTURE_CASES[0].receipt, userKey: GATEWAY_ACTOR },
  "jira.delete-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[1].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: ISSUE_URL,
  },
  "jira.archive-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[2].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: ISSUE_URL,
  },
  "jira.restore-issue": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[3].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: ISSUE_URL,
  },
  "jira.move-subtask": {
    ...ISSUE_LIFECYCLE_FIXTURE_CASES[4].receipt,
    userKey: GATEWAY_ACTOR,
    browseUrl: ISSUE_URL,
  },
  "jira.create-issues": { ...BULK_CREATE_RECEIPT, userKey: GATEWAY_ACTOR },
  "jira.create-reciprocal-remote-link": {
    userKey: GATEWAY_ACTOR,
    issueId: "10001",
    issueKey: "SYN-1",
    linkId: "51",
    browseUrl: ISSUE_URL,
    applicationLinkId: "22222222-2222-4222-8222-222222222222",
    // Independent expected digest of the two literal configured remote destinations. This source
    // expression is evaluated only with the future authorized test run, never by a producer helper.
    applicationLinkDestinationDigest: createHash("sha256")
      .update('["https://remote.example.invalid/jira","https://rpc.example.invalid/jira"]')
      .digest("hex"),
    selectedRemoteIssueId: "9223372036854775807",
    delegatedEffectRequested: true,
  },
};
const PROJECT_AFTER = {
  effects: 1,
  archived: false,
  permissionId: "7",
  priorityId: "9",
  projectTypeKey: "software",
};
const ISSUE_AFTER = { effects: 1, formalCalls: 0 };
/** No fixture state fabricates archive/deletion completion or a verified remote counterpart. */
export const PROJECT_ISSUE_EXPECTED_REMOTE_STATE: Readonly<Record<ProjectIssueOperation, object>> =
  {
    "jira.delete-project": { lifecycle: PROJECT_AFTER },
    "jira.archive-project": { lifecycle: { ...PROJECT_AFTER, archived: true } },
    "jira.restore-project": { lifecycle: PROJECT_AFTER },
    "jira.update-project-type": { lifecycle: { ...PROJECT_AFTER, projectTypeKey: "business" } },
    "jira.set-project-permission-scheme": { lifecycle: { ...PROJECT_AFTER, permissionId: "8" } },
    "jira.set-project-priority-scheme": { lifecycle: { ...PROJECT_AFTER, priorityId: "10" } },
    "jira.remove-project-priority-scheme": { lifecycle: { ...PROJECT_AFTER, priorityId: "1" } },
    "jira.archive-issues": { lifecycle: ISSUE_AFTER },
    "jira.delete-issue": { lifecycle: ISSUE_AFTER },
    "jira.archive-issue": { lifecycle: ISSUE_AFTER },
    "jira.restore-issue": { lifecycle: ISSUE_AFTER },
    "jira.move-subtask": { lifecycle: ISSUE_AFTER },
    "jira.create-issues": { lifecycle: { effects: 1 } },
    "jira.create-reciprocal-remote-link": { lifecycle: { effects: 1, localLinkObserved: true } },
  };
export const PROJECT_ISSUE_EXPECTED_OUTCOMES = {
  "jira.delete-project": "succeeded-unconfirmed",
  "jira.archive-project": "succeeded-unconfirmed",
  "jira.restore-project": "succeeded-unconfirmed",
  "jira.update-project-type": "succeeded-unconfirmed",
  "jira.set-project-permission-scheme": "succeeded-unconfirmed",
  "jira.set-project-priority-scheme": "succeeded-unconfirmed",
  "jira.remove-project-priority-scheme": "succeeded-unconfirmed",
  "jira.archive-issues": "succeeded-unconfirmed",
  "jira.delete-issue": "succeeded-unconfirmed",
  "jira.archive-issue": "succeeded-unconfirmed",
  "jira.restore-issue": "succeeded-unconfirmed",
  "jira.move-subtask": "succeeded-unconfirmed",
  "jira.create-issues": "succeeded-unconfirmed",
  "jira.create-reciprocal-remote-link": "succeeded-unconfirmed",
} as const satisfies Readonly<Record<ProjectIssueOperation, "succeeded-unconfirmed">>;
