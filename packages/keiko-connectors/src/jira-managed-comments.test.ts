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
const BASE_URL = "https://jira.example.test/context";
const ISSUE = { id: "10007", key: TARGET.issueKey, fields: { summary: "Approved issue" } };
const ISSUE_PATH = `issue/${TARGET.issueKey}?fields=summary`;
const PATH = `issue/${ISSUE.id}/comment/${TARGET.commentId}`;
const COMMENT = {
  id: TARGET.commentId,
  body: "Before",
  visibility: { type: "role", value: "Developers" },
  author: { name: "owner", displayName: "Comment owner", emailAddress: "private@example.invalid" },
  created: "2026-11-07T12:30:00.000+0000",
  self: `${BASE_URL}/rest/api/2/${PATH}`,
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
    readonly issue?: Record<string, unknown>;
  } = {},
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  let current = options.before ?? COMMENT;
  return vi.fn<JiraMutationRequest>((path, method = "GET", body) => {
    if (path === ISSUE_PATH) return Promise.resolve(response(options.issue ?? ISSUE));
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
    BASE_URL,
  );

describe("bound native comment reads and updates", () => {
  it("projects readable native content without rendered HTML, remote URLs or author email", async () => {
    const request = fixture();
    const result = await executeJiraCommentRead("jira.get-comment", TARGET, request, BASE_URL);
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
    expect(request.mock.calls).toEqual([[ISSUE_PATH], [PATH]]);
  });
  it.each([
    { ...TARGET, commentId: "../1" },
    { ...TARGET, commentId: "9223372036854775808" },
    { ...TARGET, issueKey: "../SYN-7" },
    { ...TARGET, self: "https://other.invalid" },
  ])("refuses caller-selected paths and unsafe identifiers before reading", async (args) => {
    const request = fixture();
    expect(
      (await executeJiraCommentRead("jira.get-comment", args, request, BASE_URL)).data.reason,
    ).toBe("invalid-input");
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
      expect(request).toHaveBeenCalledTimes(2);
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
        [ISSUE_PATH],
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
      expect(request.mock.calls[2]).toEqual([PATH, "PUT", { body: "**Native** comment body" }]);
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
      expect(request).toHaveBeenCalledTimes(4);
    },
  );
  it("retains an ambiguous failure even when subsequent readback matches; never retries PUT", async () => {
    const request = fixture({ write: { ok: false, reason: "timeout" } });
    expect(await update(request)).toEqual({ ok: false, reason: "timeout", receipt: TARGET });
    expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
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
    expect(request.mock.calls).toEqual([[ISSUE_PATH], [PATH]]);
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
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(["", " ", "x".repeat(32769), "bad\u0000body"])(
    "rejects invalid comment text before any request",
    async (body) => {
      const request = fixture();
      expect(
        await executeJiraCommentMutation(
          "jira.update-comment",
          { ...TARGET, body },
          request,
          false,
          BASE_URL,
        ),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("retains the existing additive comment confirmation contract", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue(response(COMMENT));
    expect(
      await confirmJiraComment(request, TARGET.issueKey, TARGET.commentId, COMMENT.body),
    ).toEqual({ ok: true, receipt: TARGET });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `issue/${TARGET.issueKey}/comment/${TARGET.commentId}`,
    );
  });
  it.each([
    undefined,
    `${BASE_URL}/rest/api/2/issue/10009/comment/${TARGET.commentId}`,
    `${BASE_URL}/rest/api/2/issue/${ISSUE.id}/comment/99`,
    `${COMMENT.self}?`,
    `${COMMENT.self}#`,
    `${COMMENT.self}?expand=anything`,
    `${COMMENT.self}#fragment`,
  ])("refuses a missing or mismatched comment binding before any PUT", async (self) => {
    const read = fixture({ before: { ...COMMENT, self } });
    expect(
      (await executeJiraCommentRead("jira.get-comment", TARGET, read, BASE_URL)).data.reason,
    ).toBe("conflict");
    const write = fixture({ before: { ...COMMENT, self } });
    expect(await update(write)).toEqual({ ok: false, reason: "conflict" });
    expect(write.mock.calls).toEqual([[ISSUE_PATH], [PATH]]);
  });
  it.each([
    `https://public.example.test/another-context/rest/api/2/${PATH}`,
    `http://internal.example.test:8080/rest/api/2/${PATH}`,
    `https://public.example.test/rest/api/2/${PATH.replace(ISSUE.id, "%31%30%30%30%37")}`,
  ])("binds proxy self metadata without following or displaying its URL: %s", async (self) => {
    const read = fixture({ before: { ...COMMENT, self } });
    const result = await executeJiraCommentRead("jira.get-comment", TARGET, read, BASE_URL);
    expect(result.data.outcome).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain(self);
    const write = fixture({
      before: { ...COMMENT, self },
      after: { ...COMMENT, self, body: "**Native** comment body" },
    });
    expect(await update(write)).toEqual({ ok: true, receipt: TARGET });
    expect(write.mock.calls.map(([path]) => path)).toEqual([ISSUE_PATH, PATH, PATH, PATH]);
  });
  it("refuses an issue lookup whose key does not match the approval", async () => {
    const request = fixture({ issue: { ...ISSUE, key: "SYN-9" } });
    expect(await update(request)).toEqual({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledExactlyOnceWith(ISSUE_PATH);
  });
  it("does not confirm a comment that moves to a different issue during readback", async () => {
    const request = fixture({
      after: {
        ...COMMENT,
        body: "**Native** comment body",
        self: `${BASE_URL}/rest/api/2/issue/10009/comment/${TARGET.commentId}`,
      },
    });
    expect(await update(request)).toEqual({ ok: false, reason: "conflict", receipt: TARGET });
    expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    expect(request.mock.calls.at(-1)).toEqual([PATH]);
  });
  it.each(["First\r\nSecond", "First\rSecond"])(
    "normalizes native line endings for edit and additive confirmation",
    async (body) => {
      const request = fixture({ after: { ...COMMENT, body: "First\nSecond" } });
      expect(
        await executeJiraCommentMutation(
          "jira.update-comment",
          { ...TARGET, body },
          request,
          false,
          BASE_URL,
        ),
      ).toEqual({ ok: true, receipt: TARGET });
      const added = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValue(response({ ...COMMENT, body: "First\nSecond" }));
      expect(await confirmJiraComment(added, TARGET.issueKey, TARGET.commentId, body)).toEqual({
        ok: true,
        receipt: TARGET,
      });
    },
  );
  it("recognizes already matching normalized text before effects", async () => {
    const request = fixture({ before: { ...COMMENT, body: "First\nSecond" } });
    expect(
      await executeJiraCommentMutation(
        "jira.update-comment",
        { ...TARGET, body: "First\r\nSecond" },
        request,
        false,
        BASE_URL,
      ),
    ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(request.mock.calls).toEqual([[ISSUE_PATH], [PATH]]);
  });
  it("refuses missing configured origin and context before reading or writing", async () => {
    const request = fixture();
    expect(
      await executeJiraCommentMutation(
        "jira.update-comment",
        { ...TARGET, body: "After" },
        request,
      ),
    ).toEqual({ ok: false, reason: "malformed-payload" });
    expect(request).not.toHaveBeenCalled();
  });
  it("recognizes only the two selected comment operations", () => {
    expect(isJiraCommentRead("jira.get-comment")).toBe(true);
    expect(isJiraCommentRead("jira.comment")).toBe(false);
    expect(isJiraCommentMutation("jira.update-comment")).toBe(true);
    expect(isJiraCommentMutation("jira.delete-comment")).toBe(false);
  });
});
