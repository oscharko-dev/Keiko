import { expect } from "vitest";
import type { AtlassianHttpBodyRequest, AtlassianHttpBodyResult } from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

const ACTOR = { key: "synthetic-actor", name: "synthetic-user" };
const FIRST = { id: "10001", key: "SYN-1" };
const SECOND = { id: "10002", key: "SYN-2" };
const TYPE = { id: "9", name: "Blocks", inward: "is blocked by", outward: "blocks" };
const VALUE = { globalId: "synthetic:42&part=1", applicationType: null, applicationName: null, relationship: null,
  url: "https://remote.example.invalid/item/42", title: "Reviewed link", summary: null, iconUrl: null, iconTitle: null, resolved: false,
  statusIconUrl: null, statusIconTitle: null, statusIconLink: null };
const EXPECTED = { id: "72", ...VALUE };
const ISSUE = { inwardIssueIdOrKey: FIRST.key, outwardIssueIdOrKey: SECOND.key, expectedActorKey: ACTOR.key, linkType: TYPE };
const REMOTE = { issueIdOrKey: FIRST.key, expectedActorKey: ACTOR.key };
export const LINK_MUTATION_FIXTURE_CASES = [
  { tool: "jira.create-issue-link", method: "POST", path: "/issueLink", query: "", args: ISSUE },
  { tool: "jira.delete-issue-link", method: "DELETE", path: "/issueLink/71", query: "", args: { ...ISSUE, linkId: "71" } },
  { tool: "jira.upsert-remote-link", method: "POST", path: "/issue/10001/remotelink", query: "", args: { ...REMOTE, value: VALUE, expectAbsent: true } },
  { tool: "jira.update-remote-link", method: "PUT", path: "/issue/10001/remotelink/72", query: "", args: { ...REMOTE, linkId: "72", expected: EXPECTED, value: { ...VALUE, title: "Updated link" } } },
  { tool: "jira.delete-remote-link", method: "DELETE", path: "/issue/10001/remotelink/72", query: "", args: { ...REMOTE, linkId: "72", expected: EXPECTED } },
  { tool: "jira.delete-remote-link-by-global-id", method: "DELETE", path: "/issue/10001/remotelink", query: "?globalId=synthetic%3A42%26part%3D1", args: { ...REMOTE, globalId: VALUE.globalId, expected: EXPECTED } },
] as const;
type LinkCase = (typeof LINK_MUTATION_FIXTURE_CASES)[number];
/** Independent primary-wire fixture: fixed native target, exact bodies, and post-effect reads. */
export function linkMutationTransportFixture(apiRoot: string, selected: LinkCase): {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => { readonly issueLinkPresent: boolean; readonly remotePresent: boolean; readonly remoteTitle: string };
} {
  let issueLinkPresent = selected.tool === "jira.delete-issue-link";
  let remotePresent = selected.tool !== "jira.upsert-remote-link";
  let remoteTitle = VALUE.title;
  const remote = () => ({ id: 72, globalId: VALUE.globalId, object: { url: VALUE.url, title: remoteTitle, status: { resolved: false } } });
  return {
    snapshot: () => ({ issueLinkPresent, remotePresent, remoteTitle }),
    read(request) {
      const url = new URL(request.url);
      if (url.pathname === `${apiRoot}/myself`) return response(ACTOR);
      if (url.pathname === `${apiRoot}/issueLinkType/9`) return response(TYPE);
      if (url.pathname === `${apiRoot}/issueLink/71`) return response({ id: "71", type: TYPE, inwardIssue: FIRST, outwardIssue: SECOND });
      if ([`${apiRoot}/issue/${FIRST.id}`, `${apiRoot}/issue/${FIRST.key}`, `${apiRoot}/issue/${SECOND.id}`, `${apiRoot}/issue/${SECOND.key}`].includes(url.pathname)) {
        const inward = url.pathname.endsWith(`/issue/${FIRST.id}`) || url.pathname.endsWith(`/issue/${FIRST.key}`);
        const edges = issueLinkPresent ? [{ id: "71", type: TYPE, [inward ? "outwardIssue" : "inwardIssue"]: inward ? SECOND : FIRST }] : [];
        return response({ ...(inward ? FIRST : SECOND), fields: { summary: "Synthetic issue", issuelinks: edges } });
      }
      if (url.pathname === `${apiRoot}/issue/10001/remotelink`) return response(remotePresent ? [remote()] : []);
      if (url.pathname === `${apiRoot}/issue/10001/remotelink/72`) return response(remote());
      return undefined;
    },
    write(request) {
      const url = new URL(request.url);
      if (url.pathname !== `${apiRoot}${selected.path}`) return undefined;
      expect(request.method).toBe(selected.method);
      expect(url.search).toBe(selected.query);
      if (selected.tool === "jira.create-issue-link") {
        expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ type: { id: "9" }, inwardIssue: { id: "10001" }, outwardIssue: { id: "10002" } });
        issueLinkPresent = true;
        return response(undefined, 201);
      }
      if (selected.tool === "jira.delete-issue-link") {
        expect(request.bodyJson).toBeUndefined();
        issueLinkPresent = false;
        return response(undefined, 204);
      }
      if (selected.tool === "jira.upsert-remote-link" || selected.tool === "jira.update-remote-link") {
        remoteTitle = selected.tool === "jira.update-remote-link" ? "Updated link" : VALUE.title;
        expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ globalId: VALUE.globalId, application: { type: null, name: null }, relationship: null,
          object: { url: VALUE.url, title: remoteTitle, summary: null, icon: { url16x16: null, title: null },
            status: { resolved: false, icon: { url16x16: null, title: null, link: null } } } });
        remotePresent = true;
        return response(selected.tool === "jira.upsert-remote-link" ? { id: 72 } : undefined, selected.tool === "jira.upsert-remote-link" ? 201 : 204);
      }
      expect(request.bodyJson).toBeUndefined();
      remotePresent = false;
      return response(undefined, 204);
    },
  };
}
