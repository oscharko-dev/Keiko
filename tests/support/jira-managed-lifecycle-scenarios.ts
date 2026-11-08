import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import { LINK_MUTATION_FIXTURE_CASES, linkMutationTransportFixture } from "./jira-link-mutation-fixture.js";
import { RELEASE_LIFECYCLE_FIXTURE_CASES, releaseLifecycleTransportFixture } from "./jira-release-lifecycle-fixture.js";

type LifecycleMutation = (typeof RELEASE_LIFECYCLE_FIXTURE_CASES)[number]["tool"] | (typeof LINK_MUTATION_FIXTURE_CASES)[number]["tool"];
const ACTOR = "synthetic-key";
const ISSUE = { issueId: "10001", issueKey: "SYN-1", userKey: ACTOR };
const RELATION = { ...ISSUE, linkedIssueId: "10002", linkedIssueKey: "SYN-2", linkTypeId: "9", linkId: "71" };
const PROJECT = { projectId: "10000", projectKey: "SYN", userKey: ACTOR };
const release = RELEASE_LIFECYCLE_FIXTURE_CASES;
const links = LINK_MUTATION_FIXTURE_CASES;
/** Literal key coverage remains independent of the production registration and adapter results. */
export const LIFECYCLE_ARGUMENTS: Readonly<Record<LifecycleMutation, CatalogJsonObject>> = {
  "jira.delete-component": { ...release[0].args, expectedActorKey: ACTOR },
  "jira.merge-version": { ...release[1].args, expectedActorKey: ACTOR },
  "jira.move-version": { ...release[2].args, expectedActorKey: ACTOR },
  "jira.remove-and-swap-version": { ...release[3].args, expectedActorKey: ACTOR },
  "jira.create-issue-link": { ...links[0].args, expectedActorKey: ACTOR },
  "jira.delete-issue-link": { ...links[1].args, expectedActorKey: ACTOR },
  "jira.upsert-remote-link": { ...links[2].args, expectedActorKey: ACTOR },
  "jira.update-remote-link": { ...links[3].args, expectedActorKey: ACTOR },
  "jira.delete-remote-link": { ...links[4].args, expectedActorKey: ACTOR },
  "jira.delete-remote-link-by-global-id": { ...links[5].args, expectedActorKey: ACTOR },
};
export const LIFECYCLE_RECEIPTS: Readonly<Record<LifecycleMutation, CatalogJsonObject>> = {
  "jira.delete-component": { ...PROJECT, componentId: "71", replacementComponentId: "72" },
  "jira.merge-version": { ...PROJECT, versionId: "81", targetVersionId: "82" },
  "jira.move-version": { ...PROJECT, versionId: "81" },
  "jira.remove-and-swap-version": { ...PROJECT, versionId: "81", replacementVersionIds: ["82"] },
  "jira.create-issue-link": { ...RELATION, linkPresent: true },
  "jira.delete-issue-link": { ...RELATION, linkPresent: false },
  "jira.upsert-remote-link": { ...ISSUE, linkId: "72", linkPresent: true },
  "jira.update-remote-link": { ...ISSUE, linkId: "72", linkPresent: true },
  "jira.delete-remote-link": { ...ISSUE, linkId: "72", linkPresent: false },
  "jira.delete-remote-link-by-global-id": { ...ISSUE, linkId: "72", linkPresent: false },
};
export const LIFECYCLE_REMOTE_STATE: Readonly<Record<LifecycleMutation, object>> = {
  "jira.delete-component": { lifecycle: { componentIds: ["72"], versionIds: ["81", "82"] } },
  "jira.merge-version": { lifecycle: { componentIds: ["71", "72"], versionIds: ["82"] } },
  "jira.move-version": { lifecycle: { componentIds: ["71", "72"], versionIds: ["82", "81"] } },
  "jira.remove-and-swap-version": { lifecycle: { componentIds: ["71", "72"], versionIds: ["82"] } },
  "jira.create-issue-link": { lifecycle: { issueLinkPresent: true } },
  "jira.delete-issue-link": { lifecycle: { issueLinkPresent: false } },
  "jira.upsert-remote-link": { lifecycle: { remotePresent: true, remoteTitle: "Reviewed link" } },
  "jira.update-remote-link": { lifecycle: { remotePresent: true, remoteTitle: "Updated link" } },
  "jira.delete-remote-link": { lifecycle: { remotePresent: false } },
  "jira.delete-remote-link-by-global-id": { lifecycle: { remotePresent: false } },
};
/** Three native operations change issue references that the entity collections cannot prove. */
export const LIFECYCLE_EXPECTED_OUTCOMES = {
  "jira.delete-component": "succeeded-unconfirmed",
  "jira.merge-version": "succeeded-unconfirmed",
  "jira.move-version": "succeeded",
  "jira.remove-and-swap-version": "succeeded-unconfirmed",
  "jira.create-issue-link": "succeeded",
  "jira.delete-issue-link": "succeeded",
  "jira.upsert-remote-link": "succeeded",
  "jira.update-remote-link": "succeeded",
  "jira.delete-remote-link": "succeeded",
  "jira.delete-remote-link-by-global-id": "succeeded",
} as const satisfies Readonly<Record<LifecycleMutation, "succeeded" | "succeeded-unconfirmed">>;
export function expectedLifecycleOutcome(operation: string): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> = LIFECYCLE_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
interface Controller {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => object;
}
const API_ROOT = "/context/rest/api/2";
function controller(operation: string | undefined): Controller | undefined {
  if (release.some((item) => item.tool === operation)) return releaseLifecycleTransportFixture(API_ROOT);
  const selected = links.find((item) => item.tool === operation);
  return selected === undefined ? undefined : linkMutationTransportFixture(API_ROOT, selected);
}
export function lifecycleRemoteFixture(operation: string | undefined): {
  readonly read: (path: string) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: Request) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => object | undefined;
} {
  const selected = controller(operation);
  return {
    read: (path) => selected?.read({ method: "GET", url: `https://203.0.113.10${path}`, timeoutMs: 1000, maxBodyBytes: 262144 }),
    async write(request) {
      if (selected === undefined) return undefined;
      const method = request.method;
      if (method !== "POST" && method !== "PUT" && method !== "DELETE") return undefined;
      const bodyJson = await request.clone().text();
      return selected.write({ method, url: request.url, timeoutMs: 1000, maxBodyBytes: 262144,
        ...(bodyJson === "" ? {} : { bodyJson }) });
    },
    snapshot: () => selected?.snapshot(),
  };
}
