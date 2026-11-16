import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { executeJiraCommentDelete, isJiraCommentDelete } from "./jira-managed-comment-delete.js";

const BASE_URL = "https://jira.example.test/context";
const ISSUE = { id: "10007", key: "SYN-7", fields: { summary: "Bound issue" } };
const TARGET = { issueKey: ISSUE.key, commentId: "9007199254740993" };
const RECEIPT = { ...TARGET, issueId: ISSUE.id };
const COMMENT_PATH = `issue/${ISSUE.id}/comment/${TARGET.commentId}`;
const COLLECTION_PATH = `issue/${ISSUE.id}/comment?startAt=0&maxResults=${String(TOOL_CATALOG_LIMITS.maxArrayItems)}`;
const COMMENT = {
  id: TARGET.commentId,
  body: "Reviewed\ncomment",
  visibility: { type: "role", value: "Developers" },
  self: `${BASE_URL}/rest/api/2/${COMMENT_PATH}`,
};
const INPUT: CatalogJsonObject = {
  ...TARGET,
  expectedBody: COMMENT.body,
  expectedVisibility: COMMENT.visibility,
};
function response(body: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
function collection(comments: readonly unknown[]): Record<string, unknown> {
  return {
    startAt: 0,
    maxResults: TOOL_CATALOG_LIMITS.maxArrayItems,
    total: comments.length,
    comments,
  };
}
interface Scenario {
  readonly approvedIssueKey?: string;
  readonly issue?: AtlassianWriteHttpOutcome;
  readonly before?: AtlassianWriteHttpOutcome;
  readonly current?: AtlassianWriteHttpOutcome;
  readonly write?: AtlassianWriteHttpOutcome;
  readonly afterIssue?: AtlassianWriteHttpOutcome | Error;
  readonly after?: AtlassianWriteHttpOutcome | Error;
}
function fixture(options: Scenario = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  const approvedIssuePath = `issue/${options.approvedIssueKey ?? ISSUE.key}?fields=summary`;
  const issue = options.issue ?? response(ISSUE);
  const current = options.current ?? response(COMMENT);
  const write: AtlassianWriteHttpOutcome = options.write ?? {
    ok: true,
    status: 204,
    body: undefined,
  };
  const afterIssue = options.afterIssue ?? response(ISSUE);
  const after = options.after ?? response(collection([]));
  const before = options.before ?? response(collection([COMMENT]));
  return vi.fn<JiraMutationRequest>((path, method = "GET") => {
    if (!written && path === approvedIssuePath) return Promise.resolve(issue);
    if (method === "DELETE") {
      expect(path).toBe(COMMENT_PATH);
      written = true;
      return Promise.resolve(write);
    }
    if (path === COMMENT_PATH) return Promise.resolve(current);
    const selected =
      path === `issue/${ISSUE.id}?fields=summary` ? afterIssue : written ? after : before;
    expect(
      path === `issue/${ISSUE.id}?fields=summary` ||
        path.startsWith(`issue/${ISSUE.id}/comment?startAt=`),
    ).toBe(true);
    return selected instanceof Error ? Promise.reject(selected) : Promise.resolve(selected);
  });
}
function remove(
  request: JiraMutationRequest,
  args = INPUT,
  check = false,
): ReturnType<typeof executeJiraCommentDelete> {
  return executeJiraCommentDelete("jira.delete-comment", args, request, check, BASE_URL);
}
function deletes(request: ReturnType<typeof fixture>): unknown[][] {
  return request.mock.calls.filter(([, method]) => method === "DELETE");
}

describe("review-bound native comment deletion", () => {
  it.each(["syn-7", ISSUE.id])(
    "retains the canonical native key when the approved issue alias is %s",
    async (issueKey) => {
      const request = fixture({ approvedIssueKey: issueKey });
      expect(await remove(request, { ...INPUT, issueKey })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
      expect(request.mock.calls[0]).toEqual([`issue/${issueKey}?fields=summary`]);
      expect(deletes(request)).toEqual([[COMMENT_PATH, "DELETE", undefined, "none"]]);
    },
  );
  it.each([200, 202, 204])(
    "requires independent same-parent absence proof after HTTP %s, with one exact DELETE",
    async (status) => {
      const request = fixture({ write: { ok: true, status, body: undefined } });
      expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
      expect(request.mock.calls).toEqual([
        [`issue/${ISSUE.key}?fields=summary`],
        [COLLECTION_PATH],
        [COMMENT_PATH],
        [COMMENT_PATH, "DELETE", undefined, "none"],
        [`issue/${ISSUE.id}?fields=summary`],
        [COLLECTION_PATH],
      ]);
    },
  );
  it("performs the same read-only admission before approval without inventing a receipt", async () => {
    const request = fixture();
    expect(await remove(request, INPUT, true)).toEqual({ ok: true, receipt: {} });
    expect(request).toHaveBeenCalledTimes(3);
    expect(deletes(request)).toEqual([]);
  });
  it.each([
    { ...INPUT, expectedBody: undefined },
    { ...INPUT, expectedBody: "x".repeat(32769) },
    { ...INPUT, expectedBody: "invalid\u0000text" },
    { ...INPUT, commentId: "9223372036854775808" },
    { ...INPUT, commentId: "../1" },
    { ...INPUT, issueKey: "../SYN-7" },
    { ...INPUT, expectedVisibility: {} },
    { ...INPUT, expectedVisibility: { type: "role", value: "Developers", extra: true } },
    { ...INPUT, expectedVisibility: null },
    { ...INPUT, self: "https://other.invalid" },
  ])("rejects incomplete or unsafe reviewed input before any request", async (args) => {
    const request = fixture();
    expect(await remove(request, args as CatalogJsonObject)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...COMMENT, body: "Changed after review" },
    { ...COMMENT, visibility: { type: "group", value: "Developers" } },
    { ...COMMENT, visibility: undefined },
    { ...COMMENT, self: `${BASE_URL}/rest/api/2/issue/10009/comment/${TARGET.commentId}` },
    { ...COMMENT, id: "98" },
  ])(
    "refuses changed reviewed content, visibility or cross-issue identity before DELETE",
    async (current) => {
      const request = fixture({ current: response(current) });
      expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
      expect(deletes(request)).toEqual([]);
    },
  );
  it("rechecks the reviewed body at execution after a previously successful preflight", async () => {
    const request = fixture();
    expect(await remove(request, INPUT, true)).toMatchObject({ ok: true });
    const changed = fixture({
      current: response({ ...COMMENT, body: "Another actor changed this" }),
    });
    expect(await remove(changed)).toMatchObject({ ok: false, reason: "conflict" });
    expect(deletes(changed)).toEqual([]);
  });
  it.each(["Reviewed\r\ncomment", "Reviewed\rcomment"])(
    "compares native line endings without changing the reviewed text",
    async (expectedBody) => {
      expect(await remove(fixture(), { ...INPUT, expectedBody })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it.each([undefined, null])(
    "allows explicitly reviewed empty unrestricted native content",
    async (visibility) => {
      const request = fixture({ current: response({ ...COMMENT, body: "", visibility }) });
      expect(await remove(request, { ...TARGET, expectedBody: "" })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it.each([
    response({ ...collection([COMMENT]), total: 2 }),
    response({ ...collection([COMMENT]), startAt: 1 }),
    response({ ...collection([COMMENT]), total: undefined }),
    response({ ...collection([COMMENT]), maxResults: 0 }),
    response({ ...collection([COMMENT]), total: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }),
    response(collection([{ ...COMMENT, id: Number.MAX_SAFE_INTEGER + 1 }])),
    response(collection([COMMENT, COMMENT])),
    response(
      collection([
        { ...COMMENT, self: `${BASE_URL}/rest/api/2/issue/10009/comment/${TARGET.commentId}` },
      ]),
    ),
    response(collection([])),
    { ok: false, reason: "permission-denied" } as const,
  ])("refuses unproven collection membership before effects", async (before) => {
    const request = fixture({ before });
    expect(await remove(request)).toMatchObject({ ok: false });
    expect(deletes(request)).toEqual([]);
  });
  it.each([
    response({ ...collection([]), total: 1 }),
    response({ ...collection([]), startAt: 1 }),
    response({ ...collection([]), total: undefined }),
    response(collection([COMMENT])),
    { ok: false, reason: "not-found", httpStatus: 404 } as const,
    { ok: false, reason: "permission-denied", httpStatus: 403 } as const,
  ])(
    "retains the target but never confirms missing, partial or still-present readback",
    async (after) => {
      const request = fixture({ after });
      expect(await remove(request)).toMatchObject({ ok: false, receipt: RECEIPT });
      expect(deletes(request)).toHaveLength(1);
    },
  );
  it.each([
    { ok: false, reason: "not-found", httpStatus: 404 } as const,
    { ok: false, reason: "permission-denied", httpStatus: 403 } as const,
    response({ ...ISSUE, id: "10009" }),
    response({ ...ISSUE, key: "SYN-8" }),
  ])("requires the same readable parent after acknowledged deletion", async (afterIssue) => {
    const request = fixture({ afterIssue });
    expect(await remove(request)).toMatchObject({ ok: false, receipt: RECEIPT });
    expect(deletes(request)).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === COLLECTION_PATH)).toHaveLength(1);
  });
  it.each([
    { ok: false, reason: "timeout" } as const,
    { ok: false, reason: "not-found", httpStatus: 404 } as const,
    { ok: false, reason: "permission-denied", httpStatus: 403 } as const,
    { ok: false, reason: "unavailable", httpStatus: 500 } as const,
    { ok: true, status: 500, body: undefined } as const,
  ])(
    "never converts a missing or unexpected DELETE acknowledgement into success or retries it",
    async (write) => {
      const request = fixture({ write });
      expect(await remove(request)).toMatchObject({ ok: false, receipt: RECEIPT });
      expect(deletes(request)).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(4);
    },
  );
  it.each(["afterIssue", "after"] as const)(
    "preserves acknowledged target and cause when %s throws",
    async (stage) => {
      const cause = new Error("Private transport failure");
      const request = fixture({ [stage]: cause });
      await expect(remove(request)).rejects.toMatchObject({
        name: JiraAcknowledgedMutationError.name,
        cause,
        receipt: RECEIPT,
      });
      expect(deletes(request)).toHaveLength(1);
    },
  );
  it("recognizes only the native comment delete operation", () => {
    expect(isJiraCommentDelete("jira.delete-comment")).toBe(true);
    expect(isJiraCommentDelete("jira.update-comment")).toBe(false);
  });
});

it("proves same-parent membership and deletion absence across more than one thousand comments", async () => {
  let written = false;
  const others = Array.from({ length: 1200 }, (_, index) => {
    const id = String(index + 1);
    return { id, self: `${BASE_URL}/rest/api/2/issue/${ISSUE.id}/comment/${id}` };
  });
  const offsets: number[] = [];
  const request = vi.fn<JiraMutationRequest>((path, method = "GET") => {
    if (path === `issue/${ISSUE.key}?fields=summary` || path === `issue/${ISSUE.id}?fields=summary`)
      return Promise.resolve(response(ISSUE));
    if (method === "DELETE") {
      expect(path).toBe(COMMENT_PATH);
      written = true;
      return Promise.resolve({ ok: true, status: 204, body: undefined });
    }
    if (path === COMMENT_PATH) return Promise.resolve(response(COMMENT));
    const query = new URLSearchParams(path.split("?")[1]);
    const startAt = Number(query.get("startAt"));
    offsets.push(startAt);
    const comments = written ? others : [...others, COMMENT];
    return Promise.resolve(
      response({
        startAt,
        maxResults: 1000,
        total: comments.length,
        comments: comments.slice(startAt, startAt + 1000),
      }),
    );
  });
  expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
  expect(offsets).toEqual([0, 1000, 0, 1000]);
  expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
});
it.each(["timeout", "cancelled", "effect-denied"] as const)(
  "stops paged admission on the existing %s request budget without an effect",
  async (reason) => {
    const request = vi.fn<JiraMutationRequest>((path) => {
      if (path === `issue/${ISSUE.key}?fields=summary`) return Promise.resolve(response(ISSUE));
      if (path === COLLECTION_PATH)
        return Promise.resolve(response({ ...collection([COMMENT]), total: 2 }));
      expect(path).toBe(`issue/${ISSUE.id}/comment?startAt=1&maxResults=1000`);
      return Promise.resolve({ ok: false, reason });
    });
    expect(await remove(request)).toMatchObject({ ok: false, reason });
    expect(request.mock.calls.every(([, method]) => method !== "DELETE")).toBe(true);
  },
);
