import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

export const ISSUE_ACTION_BASE_URL = "https://jira.example.invalid/context";
export const ISSUE_ACTION_USER = { key: "recipient-key", name: "Recipient User" };
const COMMON = { expectedActorKey: "synthetic-actor", issueId: "10001", issueKey: "SYN-1" };
export const ISSUE_ACTION_FIXTURE_CASES = [
  {
    name: "jira.pin-comment",
    args: { ...COMMON, commentId: "9007199254740993", expectedBody: "Reviewed comment" },
    method: "PUT",
    path: "issue/10001/comment/9007199254740993/pin",
    body: true,
    confirmed: true,
    receipt: {
      userKey: "synthetic-actor",
      issueId: "10001",
      issueKey: "SYN-1",
      commentId: "9007199254740993",
      commentPinned: true,
    },
  },
  {
    name: "jira.notify-issue",
    args: {
      ...COMMON,
      subject: "Delivery update",
      textBody: "Please review SYN-1.",
      users: [ISSUE_ACTION_USER],
      confirmEmailSend: true,
    },
    method: "POST",
    path: "issue/10001/notify",
    body: {
      subject: "Delivery update",
      textBody: "Please review SYN-1.",
      to: { users: [{ name: "Recipient User" }] },
    },
    confirmed: false,
    receipt: {
      userKey: "synthetic-actor",
      issueId: "10001",
      issueKey: "SYN-1",
      notificationDigest: "df218b3e42ab128005578b0d0ffb7c0b9f7f640e95d6c90d38108b59201ca5bd",
      recipientUserKeys: ["recipient-key"],
    },
  },
] as const;
interface IssueActionControls {
  pinned: boolean;
  lostAck: boolean;
  wrongReadback: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  malformedPinned: boolean;
  aliasUser: boolean;
  nativeRefusal: "permission-denied" | "not-found" | undefined;
}
interface IssueActionState {
  readonly actor: { key: string; name: string };
  readonly issue: { id: string; key: string; fields: { summary: string } };
  readonly comment: Record<string, unknown>;
  readonly controls: IssueActionControls;
  effects: number;
}
export interface IssueActionFixture {
  readonly request: JiraMutationRequest;
  readonly calls: { path: string; method: string; body: unknown; expect: string }[];
  readonly actor: { key: string; name: string };
  readonly issue: { id: string; key: string; fields: { summary: string } };
  readonly comment: Record<string, unknown>;
  readonly controls: IssueActionControls;
  readonly effects: () => number;
}
const issueActionObject = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
function issueActionReadAfterEffect(
  state: IssueActionState,
): AtlassianWriteHttpOutcome | undefined {
  const { controls } = state;
  if (state.effects > 0 && controls.throwReadback) {
    throw new TypeError("fixture acknowledged failure");
  }
  return state.effects > 0 && controls.denyReadback
    ? { ok: false, reason: "permission-denied" }
    : undefined;
}
function issueActionPinned(state: IssueActionState): AtlassianWriteHttpOutcome {
  const { controls, comment } = state;
  const items = controls.malformedPinned
    ? [{ comment: { id: comment.id } }]
    : controls.pinned && !controls.wrongReadback
      ? [{ comment: { ...comment }, pinnedBy: "operator" }]
      : [];
  return { ok: true, status: 200, body: undefined, items };
}
function issueActionRead(state: IssueActionState, resource: string): AtlassianWriteHttpOutcome {
  const refused = issueActionReadAfterEffect(state);
  if (refused !== undefined) return refused;
  switch (resource) {
    case "myself":
      return issueActionObject(state.actor);
    case "user":
      return issueActionObject({
        ...ISSUE_ACTION_USER,
        ...(state.controls.aliasUser ? { key: "different-key" } : {}),
      });
    case "issue/SYN-1":
    case "issue/10001":
      return issueActionObject(state.issue);
    case "issue/10001/comment/9007199254740993":
      return issueActionObject(state.comment);
    case "issue/10001/pinned-comments":
      return issueActionPinned(state);
    default:
      throw new TypeError("Unexpected fixture issue-action read");
  }
}
function issueActionWrite(state: IssueActionState, resource: string): AtlassianWriteHttpOutcome {
  const { controls } = state;
  state.effects += 1;
  if (controls.nativeRefusal !== undefined) return { ok: false, reason: controls.nativeRefusal };
  if (resource.endsWith("/pin")) controls.pinned = true;
  else if (!resource.endsWith("/notify")) throw new TypeError("Unexpected issue action effect");
  return controls.lostAck
    ? { ok: false, reason: "timeout" }
    : { ok: true, status: 204, body: undefined };
}
function issueActionState(): IssueActionState {
  return {
    actor: { key: "synthetic-actor", name: "operator" },
    issue: { id: "10001", key: "SYN-1", fields: { summary: "Reviewed issue" } },
    comment: {
      id: "9007199254740993",
      body: "Reviewed comment",
      created: "2026-11-08T00:00:00Z",
      self: `${ISSUE_ACTION_BASE_URL}/rest/api/2/issue/10001/comment/9007199254740993`,
    },
    controls: {
      pinned: false,
      lostAck: false,
      wrongReadback: false,
      denyReadback: false,
      throwReadback: false,
      malformedPinned: false,
      aliasUser: false,
      nativeRefusal: undefined,
    },
    effects: 0,
  };
}
export function issueActionFixture(): IssueActionFixture {
  const state = issueActionState();
  const calls: IssueActionFixture["calls"] = [];
  const request: JiraMutationRequest = (path, method = "GET", body, expect = "json") =>
    settleSync(() => {
      calls.push({
        path,
        method,
        body: body === undefined ? undefined : structuredClone(body),
        expect,
      });
      const resource = new URL(`https://fixture.invalid/${path}`).pathname.slice(1);
      return method === "GET"
        ? issueActionRead(state, resource)
        : issueActionWrite(state, resource);
    });
  const { actor, issue, comment, controls } = state;
  return { request, calls, actor, issue, comment, controls, effects: () => state.effects };
}
