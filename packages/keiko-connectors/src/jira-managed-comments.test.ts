import { describe, expect, it, vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraCommentRead,
  executeJiraCommentMutation,
  isJiraCommentRead,
  isJiraCommentMutation,
} from "./jira-managed-comments.js";
import { confirmJiraComment } from "./jira-mutation-confirmation.js";

const TARGET = { issueKey: "SYN-7", commentId: "9007199254740993" };
const PATH = `issue/${TARGET.issueKey}/comment/${TARGET.commentId}`;
const COMMENT = {
  id: TARGET.commentId,
  body: "Before",
  visibility: { type: "role", value: "Developers" },
  author: { name: "owner", displayName: "Comment owner", emailAddress: "private@example.invalid" },
  created: "2026-11-07T12:30:00.000+0000",
  self: "https://untrusted.example.invalid/comment",
  renderedBody: "<script>untrusted</script>",
};
function response(body: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
function fixture(
  options: {
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly write?: AtlassianWriteHttpOutcome;
  } = {},
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  let current = options.before ?? COMMENT;
  return vi.fn<JiraMutationRequest>((path, method = "GET", body) => {
    expect(path).toBe(PATH);
    if (method === "PUT") {
      written = true;
      current = { ...current, ...body };
      return Promise.resolve(options.write ?? response(current));
    }
    return Promise.resolve(response(written ? (options.after ?? current) : current));
  });
}
const update = (
  request: JiraMutationRequest,
  check = false,
): ReturnType<typeof executeJiraCommentMutation> =>
  executeJiraCommentMutation(
    "jira.update-comment",
    { ...TARGET, body: "**Native** comment body" },
    request,
    check,
  );

describe("bound native comment reads and updates", () => {
  it("projects readable native content without rendered HTML, remote URLs or author email", async () => {
    const request = fixture();
    const result = await executeJiraCommentRead("jira.get-comment", TARGET, request);
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [
        {
          id: TARGET.commentId,
          issueKey: TARGET.issueKey,
          body: COMMENT.body,
          visibility: COMMENT.visibility,
          created: COMMENT.created,
          authorName: "owner",
          authorDisplayName: "Comment owner",
        },
      ],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(PATH);
  });
  it.each([
    { ...TARGET, commentId: "../1" },
    { ...TARGET, commentId: "9223372036854775808" },
    { ...TARGET, issueKey: "../SYN-7" },
    { ...TARGET, self: "https://other.invalid" },
  ])("refuses caller-selected paths and unsafe identifiers before reading", async (args) => {
    const request = fixture();
    expect((await executeJiraCommentRead("jira.get-comment", args, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { type: "unknown", value: "Developers" },
    { type: "role" },
    { type: "role", value: "Developers", identifier: "1" },
  ])(
    "refuses unknown restrictions before a write instead of broadening visibility",
    async (visibility) => {
      const request = fixture({ before: { ...COMMENT, visibility } });
      expect(await update(request)).toEqual({ ok: false, reason: "malformed-payload" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["role", "group"])(
    "preserves the exact %s restriction and confirms the original resource",
    async (type) => {
      const request = fixture({
        before: { ...COMMENT, visibility: { type, value: "Developers" } },
      });
      expect(await update(request)).toEqual({ ok: true, receipt: TARGET });
      expect(request.mock.calls).toEqual([
        [PATH],
        [
          PATH,
          "PUT",
          { body: "**Native** comment body", visibility: { type, value: "Developers" } },
        ],
        [PATH],
      ]);
    },
  );
  it.each([undefined, null])(
    "preserves an unrestricted native comment without inventing a restriction",
    async (visibility) => {
      const request = fixture({ before: { ...COMMENT, visibility } });
      expect(await update(request)).toEqual({ ok: true, receipt: TARGET });
      expect(request.mock.calls[1]).toEqual([PATH, "PUT", { body: "**Native** comment body" }]);
    },
  );
  it.each([
    { ...COMMENT, body: "**Native** comment body", visibility: undefined },
    {
      ...COMMENT,
      body: "**Native** comment body",
      visibility: { type: "group", value: "Developers" },
    },
    { ...COMMENT, body: "**Native** comment body", visibility: { type: "role", value: "Other" } },
    { ...COMMENT, body: "Different" },
    { ...COMMENT, id: "99", body: "**Native** comment body" },
  ])(
    "does not confirm changed visibility, identity or body from independent readback",
    async (after) => {
      const request = fixture({ after });
      expect(await update(request)).toEqual({ ok: false, reason: "conflict", receipt: TARGET });
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
  it("retains an ambiguous failure even when subsequent readback matches; never retries PUT", async () => {
    const request = fixture({ write: { ok: false, reason: "timeout" } });
    expect(await update(request)).toEqual({ ok: false, reason: "timeout", receipt: TARGET });
    expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not treat a wrong mutation acknowledgement as success", async () => {
    const request = fixture({ write: response({ ...COMMENT, id: "99" }) });
    expect(await update(request)).toEqual({
      ok: false,
      reason: "conflict",
      receipt: TARGET,
    });
  });
  it("validates a preflight without issuing a mutation or fabricating a receipt", async () => {
    const request = fixture();
    expect(await update(request, true)).toEqual({ ok: true, receipt: {} });
    expect(request).toHaveBeenCalledExactlyOnceWith(PATH);
  });
  it("reports an unchanged body without performing a PUT", async () => {
    const request = fixture({ before: { ...COMMENT, body: "**Native** comment body" } });
    expect(await update(request)).toEqual({
      ok: false,
      reason: "conflict",
      receipt: TARGET,
      detail: {
        unchanged: true,
        messages: ["The comment already holds the requested text. Nothing was written."],
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["", " ", "x".repeat(32769), "bad\u0000body"])(
    "rejects invalid comment text before any request",
    async (body) => {
      const request = fixture();
      expect(
        await executeJiraCommentMutation("jira.update-comment", { ...TARGET, body }, request),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("retains the existing additive comment confirmation contract", async () => {
    expect(
      await confirmJiraComment(fixture(), TARGET.issueKey, TARGET.commentId, COMMENT.body),
    ).toEqual({ ok: true, receipt: TARGET });
  });
  it("recognizes only the two selected comment operations", () => {
    expect(isJiraCommentRead("jira.get-comment")).toBe(true);
    expect(isJiraCommentRead("jira.comment")).toBe(false);
    expect(isJiraCommentMutation("jira.update-comment")).toBe(true);
    expect(isJiraCommentMutation("jira.delete-comment")).toBe(false);
  });
});
