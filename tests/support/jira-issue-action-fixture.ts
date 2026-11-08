import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

export const ISSUE_ACTION_BASE_URL = "https://jira.example.invalid/context";
export const ISSUE_ACTION_USER = { key: "recipient-key", name: "Recipient User" };
const COMMON = { expectedActorKey: "synthetic-actor", issueId: "10001", issueKey: "SYN-1" };
export const ISSUE_ACTION_FIXTURE_CASES = [
  { name: "jira.pin-comment", args: { ...COMMON, commentId: "9007199254740993", expectedBody: "Reviewed comment" }, method: "PUT", path: "issue/10001/comment/9007199254740993/pin", body: true, confirmed: true,
    receipt: { userKey: "synthetic-actor", issueId: "10001", issueKey: "SYN-1", commentId: "9007199254740993", commentPinned: true } },
  { name: "jira.notify-issue", args: { ...COMMON, subject: "Delivery update", textBody: "Please review SYN-1.", users: [ISSUE_ACTION_USER], confirmEmailSend: true }, method: "POST", path: "issue/10001/notify",
    body: { subject: "Delivery update", textBody: "Please review SYN-1.", to: { users: [{ name: "Recipient User" }] } }, confirmed: false,
    receipt: { userKey: "synthetic-actor", issueId: "10001", issueKey: "SYN-1", notificationDigest: "df218b3e42ab128005578b0d0ffb7c0b9f7f640e95d6c90d38108b59201ca5bd", recipientUserKeys: ["recipient-key"] } },
] as const;
export function issueActionFixture() {
  const actor = { key: "synthetic-actor", name: "operator" };
  const issue = { id: "10001", key: "SYN-1", fields: { summary: "Reviewed issue" } };
  const comment: Record<string, unknown> = { id: "9007199254740993", body: "Reviewed comment", created: "2026-11-08T00:00:00Z", self: `${ISSUE_ACTION_BASE_URL}/rest/api/2/issue/10001/comment/9007199254740993` };
  const controls = { pinned: false, lostAck: false, wrongReadback: false, denyReadback: false, throwReadback: false,
    malformedPinned: false, aliasUser: false, nativeRefusal: undefined as "permission-denied" | "not-found" | undefined };
  const calls: { path: string; method: string; body: unknown; expect: string }[] = [];
  let effects = 0;
  const object = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body });
  function readAfterEffect(): AtlassianWriteHttpOutcome | undefined {
    if (effects > 0 && controls.throwReadback) throw new TypeError("fixture acknowledged failure");
    return effects > 0 && controls.denyReadback ? { ok: false, reason: "permission-denied" } : undefined;
  }
  function pinned(): AtlassianWriteHttpOutcome {
    const items = controls.malformedPinned ? [{ comment: { id: comment.id } }]
      : controls.pinned && !controls.wrongReadback ? [{ comment: { ...comment }, pinnedBy: "operator" }] : [];
    return { ok: true, status: 200, body: undefined, items };
  }
  function read(resource: string): AtlassianWriteHttpOutcome {
    const refused = readAfterEffect();
    if (refused !== undefined) return refused;
    switch (resource) {
      case "myself": return object(actor);
      case "user": return object({ ...ISSUE_ACTION_USER, ...(controls.aliasUser ? { key: "different-key" } : {}) });
      case "issue/SYN-1": case "issue/10001": return object(issue);
      case "issue/10001/comment/9007199254740993": return object(comment);
      case "issue/10001/pinned-comments": return pinned();
      default: throw new TypeError("Unexpected fixture issue-action read");
    }
  }
  function write(resource: string): AtlassianWriteHttpOutcome {
    effects += 1;
    if (controls.nativeRefusal !== undefined) return { ok: false, reason: controls.nativeRefusal };
    if (resource.endsWith("/pin")) controls.pinned = true;
    else if (!resource.endsWith("/notify")) throw new TypeError("Unexpected issue action effect");
    return controls.lostAck ? { ok: false, reason: "timeout" } : { ok: true, status: 204, body: undefined };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect = "json") => {
    calls.push({ path, method, body: body === undefined ? undefined : structuredClone(body), expect });
    const resource = new URL(`https://fixture.invalid/${path}`).pathname.slice(1);
    return method === "GET" ? read(resource) : write(resource);
  };
  return { request, calls, actor, issue, comment, controls, effects: () => effects };
}
