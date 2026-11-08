import { projectIssueTransportController } from "./jira-project-issue-transport-fixture.js";
import { systemAdministrationTransportController } from "./jira-system-administration-transport-fixture.js";
import { permissionRoleTransportController } from "./jira-permission-role-transport-fixture.js";
import { schemeSettingTransportController } from "./jira-scheme-setting-transport-fixture.js";
import { emailTemplateTransportController } from "./jira-email-template-transport-fixture.js";
import { jiraManagedScenarios, type JiraManagedScenario } from "./jira-managed-scenario.js";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import { LINK_MUTATION_FIXTURE_CASES, linkMutationTransportFixture } from "./jira-link-mutation-fixture.js";
import { RELEASE_LIFECYCLE_FIXTURE_CASES, releaseLifecycleTransportFixture } from "./jira-release-lifecycle-fixture.js";
import { configurationTransportController } from "./jira-managed-configuration-scenarios.js";
import { planningTransportController } from "./jira-managed-planning-scenarios.js";

type LifecycleMutation = (typeof RELEASE_LIFECYCLE_FIXTURE_CASES)[number]["tool"] | (typeof LINK_MUTATION_FIXTURE_CASES)[number]["tool"];
const ACTOR = "synthetic-key";
const ISSUE = { issueId: "10001", issueKey: "SYN-1", userKey: ACTOR };
const RELATION = { ...ISSUE, linkedIssueId: "10002", linkedIssueKey: "SYN-2", linkTypeId: "9", linkId: "71" };
const PROJECT = { projectId: "10000", projectKey: "SYN", userKey: ACTOR };
const release = RELEASE_LIFECYCLE_FIXTURE_CASES;
const links = LINK_MUTATION_FIXTURE_CASES;
/** Literal key coverage remains independent of the production registration and adapter results. */
const SCENARIOS = {
  // These three native bulk effects change issue references beyond the entity collection proof.
  "jira.delete-component": {
    args: release[0].args,
    receipt: { ...PROJECT, componentId: "71", replacementComponentId: "72" },
    remoteState: { lifecycle: { componentIds: ["72"], versionIds: ["81", "82"] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.merge-version": {
    args: release[1].args,
    receipt: { ...PROJECT, versionId: "81", targetVersionId: "82" },
    remoteState: { lifecycle: { componentIds: ["71", "72"], versionIds: ["82"] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.move-version": {
    args: release[2].args,
    receipt: { ...PROJECT, versionId: "81" },
    remoteState: { lifecycle: { componentIds: ["71", "72"], versionIds: ["82", "81"] } },
    outcome: "succeeded",
  },
  "jira.remove-and-swap-version": {
    args: release[3].args,
    receipt: { ...PROJECT, versionId: "81", replacementVersionIds: ["82"] },
    remoteState: { lifecycle: { componentIds: ["71", "72"], versionIds: ["82"] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-issue-link": {
    args: links[0].args,
    receipt: { ...RELATION, linkPresent: true },
    remoteState: { lifecycle: { issueLinkPresent: true } },
    outcome: "succeeded",
  },
  "jira.delete-issue-link": {
    args: links[1].args,
    receipt: { ...RELATION, linkPresent: false },
    remoteState: { lifecycle: { issueLinkPresent: false } },
    outcome: "succeeded",
  },
  "jira.upsert-remote-link": {
    args: links[2].args,
    receipt: { ...ISSUE, linkId: "72", linkPresent: true },
    remoteState: { lifecycle: { remotePresent: true, remoteTitle: "Reviewed link" } },
    outcome: "succeeded",
  },
  "jira.update-remote-link": {
    args: links[3].args,
    receipt: { ...ISSUE, linkId: "72", linkPresent: true },
    remoteState: { lifecycle: { remotePresent: true, remoteTitle: "Updated link" } },
    outcome: "succeeded",
  },
  "jira.delete-remote-link": {
    args: links[4].args,
    receipt: { ...ISSUE, linkId: "72", linkPresent: false },
    remoteState: { lifecycle: { remotePresent: false } },
    outcome: "succeeded",
  },
  "jira.delete-remote-link-by-global-id": {
    args: links[5].args,
    receipt: { ...ISSUE, linkId: "72", linkPresent: false },
    remoteState: { lifecycle: { remotePresent: false } },
    outcome: "succeeded",
  },
} satisfies Readonly<Record<LifecycleMutation, JiraManagedScenario>>;
export const {
  arguments: LIFECYCLE_ARGUMENTS,
  receipts: LIFECYCLE_RECEIPTS,
  remoteState: LIFECYCLE_REMOTE_STATE,
  outcomes: LIFECYCLE_EXPECTED_OUTCOMES,
  expectedOutcome: expectedLifecycleOutcome,
} = jiraManagedScenarios(SCENARIOS, ACTOR);
interface Controller {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined | Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined | Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => object;
}
const API_ROOT = "/context/rest/api/2";
function controller(operation: string | undefined): Controller | undefined {
  const projectIssue = projectIssueTransportController(operation, ACTOR, "https://203.0.113.10/context");
  if (projectIssue !== undefined) return projectIssue;
  const next = systemAdministrationTransportController(operation, ACTOR) ?? schemeSettingTransportController(operation, ACTOR) ?? emailTemplateTransportController(operation, ACTOR);
  if (next !== undefined) return next;
  const permissionRole = permissionRoleTransportController(operation, ACTOR);
  if (permissionRole !== undefined) return permissionRole;
  const planning = planningTransportController(operation);
  if (planning !== undefined) return planning;
  const configuration = configurationTransportController(operation);
  if (configuration !== undefined) return configuration;
  if (release.some((item) => item.tool === operation)) return releaseLifecycleTransportFixture(API_ROOT);
  const selected = links.find((item) => item.tool === operation);
  return selected === undefined ? undefined : linkMutationTransportFixture(API_ROOT, selected);
}
export function lifecycleRemoteFixture(operation: string | undefined): {
  readonly read: (url: string) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (request: Request) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => object | undefined;
} {
  const selected = controller(operation);
  return {
    read: async (url) => selected?.read({ method: "GET", url, timeoutMs: 1000, maxBodyBytes: 262144,
      ...(new URL(url).pathname === "/context/rest/api/2/project/10000/priorityscheme" &&
        (operation === "jira.set-project-priority-scheme" || operation === "jira.remove-project-priority-scheme") ? { jiraProjectPriority: true } : {}),
      ...(new URL(url).pathname === "/context/rest/api/2/applicationrole" && (operation === "jira.set-application-role" || operation === "jira.set-application-roles") ? { jiraApplicationRole: "version" } : {}),
      ...(new URL(url).pathname === "/context/rest/api/2/email-templates" ? { jiraEmailTemplateArchive: true } : {}),
    }),
    async write(request) {
      if (selected === undefined) return undefined;
      const method = request.method;
      if (method !== "POST" && method !== "PUT" && method !== "DELETE") return undefined;
      const archive = request.headers.get("content-type") === "application/zip";
      const bodyJson = archive ? "" : await request.clone().text();
      return selected.write({ method, url: request.url, timeoutMs: 1000, maxBodyBytes: 262144,
        ...directoryRequestFlags(request),
        ...(request.headers.get("content-type") === "text/plain" ? { jiraPermissionAttribute: true } : {}),
        ...(archive ? { jiraEmailTemplateArchive: true, upload: { contentType: "application/zip", bytes: new Uint8Array(await request.clone().arrayBuffer()) } } : {}),
        ...(bodyJson === "" ? {} : { bodyJson }) });
    },
    snapshot: () => selected?.snapshot(),
  };
}

/** Reconstruct only flags backed by native headers/media on their fixed routes. The controller
 * asserts these flags, so missing/misrouted gateway headers cannot be hidden by the fixture. */
function directoryRequestFlags(request: Request): Pick<AtlassianHttpBodyRequest,
  "jiraApplicationRole" | "jiraUserApplication" | "jiraUserColumns" | "jiraExperimental" | "jiraProjectPriority"> {
  const path = new URL(request.url).pathname;
  const experimental = request.headers.get("x-experimentalapi") === "true";
  const ifMatch = request.headers.get("if-match");
  const projectPriority = /^\/context\/rest\/api\/2\/project\/[1-9][0-9]*\/priorityscheme(?:\/[1-9][0-9]*)?$/u.test(path);
  return {
    ...(experimental && path === "/context/rest/api/2/user/application" ? { jiraUserApplication: true } : {}),
    ...(experimental && projectPriority ? { jiraProjectPriority: true } : {}),
    ...(experimental && !projectPriority && path !== "/context/rest/api/2/user/application" ? { jiraExperimental: true } : {}),
    ...(request.method === "PUT" && (path === "/context/rest/api/2/applicationrole" || path === "/context/rest/api/2/applicationrole/jira-software") && ifMatch !== null
      ? { jiraApplicationRole: { ifMatch } } : {}),
    ...(request.method === "PUT" && path === "/context/rest/api/2/user/columns" && request.headers.get("content-type") === "application/x-www-form-urlencoded"
      ? { jiraUserColumns: true } : {}),
  };
}
