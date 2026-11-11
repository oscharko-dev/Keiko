import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

const ACTOR = { key: "synthetic-actor", name: "synthetic-user" };
const FIRST = { id: "10001", key: "SYN-1" };
const SECOND = { id: "10002", key: "SYN-2" };
const TYPE = { id: "9", name: "Blocks", inward: "is blocked by", outward: "blocks" };
const VALUE = {
  globalId: "synthetic:42&part=1",
  applicationType: null,
  applicationName: null,
  relationship: null,
  url: "https://remote.example.invalid/item/42",
  title: "Reviewed link",
  summary: null,
  iconUrl: null,
  iconTitle: null,
  resolved: false,
  statusIconUrl: null,
  statusIconTitle: null,
  statusIconLink: null,
};
const EXPECTED = { id: "72", ...VALUE };
const ISSUE = {
  inwardIssueIdOrKey: FIRST.key,
  outwardIssueIdOrKey: SECOND.key,
  expectedActorKey: ACTOR.key,
  linkType: TYPE,
};
const REMOTE = { issueIdOrKey: FIRST.key, expectedActorKey: ACTOR.key };
export const LINK_MUTATION_FIXTURE_CASES = [
  { tool: "jira.create-issue-link", method: "POST", path: "/issueLink", query: "", args: ISSUE },
  {
    tool: "jira.delete-issue-link",
    method: "DELETE",
    path: "/issueLink/71",
    query: "",
    args: { ...ISSUE, linkId: "71" },
  },
  {
    tool: "jira.upsert-remote-link",
    method: "POST",
    path: "/issue/10001/remotelink",
    query: "",
    args: { ...REMOTE, value: VALUE, expectAbsent: true },
  },
  {
    tool: "jira.update-remote-link",
    method: "PUT",
    path: "/issue/10001/remotelink/72",
    query: "",
    args: {
      ...REMOTE,
      linkId: "72",
      expected: EXPECTED,
      value: { ...VALUE, title: "Updated link" },
    },
  },
  {
    tool: "jira.delete-remote-link",
    method: "DELETE",
    path: "/issue/10001/remotelink/72",
    query: "",
    args: { ...REMOTE, linkId: "72", expected: EXPECTED },
  },
  {
    tool: "jira.delete-remote-link-by-global-id",
    method: "DELETE",
    path: "/issue/10001/remotelink",
    query: "?globalId=synthetic%3A42%26part%3D1",
    args: { ...REMOTE, globalId: VALUE.globalId, expected: EXPECTED },
  },
] as const;
type LinkCase = (typeof LINK_MUTATION_FIXTURE_CASES)[number];
interface LinkTransportFixture {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => {
    readonly issueLinkPresent: boolean;
    readonly remotePresent: boolean;
    readonly remoteTitle: string;
  };
}
interface LinkState {
  issueLinkPresent: boolean;
  remotePresent: boolean;
  remoteTitle: string;
}
interface LinkRemoteBody {
  readonly id: number;
  readonly globalId: string;
  readonly object: {
    readonly url: string;
    readonly title: string;
    readonly status: { readonly resolved: boolean };
  };
}

function linkRemote(state: LinkState): LinkRemoteBody {
  return {
    id: 72,
    globalId: VALUE.globalId,
    object: { url: VALUE.url, title: state.remoteTitle, status: { resolved: false } },
  };
}

function linkIssueRead(state: LinkState, pathname: string): AtlassianHttpBodyResult {
  const inward =
    pathname.endsWith(`/issue/${FIRST.id}`) || pathname.endsWith(`/issue/${FIRST.key}`);
  const edges = state.issueLinkPresent
    ? [
        {
          id: "71",
          type: TYPE,
          [inward ? "outwardIssue" : "inwardIssue"]: inward ? SECOND : FIRST,
        },
      ]
    : [];
  return response({
    ...(inward ? FIRST : SECOND),
    fields: { summary: "Synthetic issue", issuelinks: edges },
  });
}

function linkStaticRead(apiRoot: string, pathname: string): AtlassianHttpBodyResult | undefined {
  if (pathname === `${apiRoot}/myself`) return response(ACTOR);
  if (pathname === `${apiRoot}/issueLinkType/9`) return response(TYPE);
  if (pathname === `${apiRoot}/issueLink/71`)
    return response({ id: "71", type: TYPE, inwardIssue: FIRST, outwardIssue: SECOND });
  return undefined;
}

function linkRead(
  state: LinkState,
  apiRoot: string,
  request: AtlassianHttpBodyRequest,
): AtlassianHttpBodyResult | undefined {
  const { pathname } = new URL(request.url);
  const fixed = linkStaticRead(apiRoot, pathname);
  if (fixed !== undefined) return fixed;
  const issuePaths = [FIRST.id, FIRST.key, SECOND.id, SECOND.key].map(
    (selector) => `${apiRoot}/issue/${selector}`,
  );
  if (issuePaths.includes(pathname)) return linkIssueRead(state, pathname);
  if (pathname === `${apiRoot}/issue/10001/remotelink`)
    return response(state.remotePresent ? [linkRemote(state)] : []);
  if (pathname === `${apiRoot}/issue/10001/remotelink/72`) return response(linkRemote(state));
  return undefined;
}

function linkRemoteWrite(
  state: LinkState,
  selected: LinkCase,
  request: AtlassianHttpBodyRequest,
): AtlassianHttpBodyResult {
  const upsert = selected.tool === "jira.upsert-remote-link";
  state.remoteTitle = selected.tool === "jira.update-remote-link" ? "Updated link" : VALUE.title;
  expect(JSON.parse(request.bodyJson ?? "null")).toEqual({
    globalId: VALUE.globalId,
    application: { type: null, name: null },
    relationship: null,
    object: {
      url: VALUE.url,
      title: state.remoteTitle,
      summary: null,
      icon: { url16x16: null, title: null },
      status: { resolved: false, icon: { url16x16: null, title: null, link: null } },
    },
  });
  state.remotePresent = true;
  return response(upsert ? { id: 72 } : undefined, upsert ? 201 : 204);
}

function linkWrite(
  state: LinkState,
  apiRoot: string,
  selected: LinkCase,
  request: AtlassianHttpBodyRequest,
): AtlassianHttpBodyResult | undefined {
  const url = new URL(request.url);
  if (url.pathname !== `${apiRoot}${selected.path}`) return undefined;
  expect(request.method).toBe(selected.method);
  expect(url.search).toBe(selected.query);
  if (selected.tool === "jira.create-issue-link") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({
      type: { id: "9" },
      inwardIssue: { id: "10001" },
      outwardIssue: { id: "10002" },
    });
    state.issueLinkPresent = true;
    return response(undefined, 201);
  }
  if (selected.tool === "jira.delete-issue-link") {
    expect(request.bodyJson).toBeUndefined();
    state.issueLinkPresent = false;
    return response(undefined, 204);
  }
  if (selected.tool === "jira.upsert-remote-link" || selected.tool === "jira.update-remote-link")
    return linkRemoteWrite(state, selected, request);
  expect(request.bodyJson).toBeUndefined();
  state.remotePresent = false;
  return response(undefined, 204);
}

/** Independent primary-wire fixture: fixed native target, exact bodies, and post-effect reads. */
export function linkMutationTransportFixture(
  apiRoot: string,
  selected: LinkCase,
): LinkTransportFixture {
  const state: LinkState = {
    issueLinkPresent: selected.tool === "jira.delete-issue-link",
    remotePresent: selected.tool !== "jira.upsert-remote-link",
    remoteTitle: VALUE.title,
  };
  return {
    snapshot: () => ({ ...state }),
    read: (request) => linkRead(state, apiRoot, request),
    write: (request) => linkWrite(state, apiRoot, selected, request),
  };
}
