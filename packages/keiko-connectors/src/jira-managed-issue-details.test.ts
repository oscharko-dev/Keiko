import { describe, expect, it, vi } from "vitest";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { executeJiraIssueDetailRead } from "./jira-managed-issue-details.js";

const TYPE = {
  id: "10",
  name: "Blocks",
  inward: "is blocked by",
  outward: "blocks",
  self: "https://untrusted.invalid/type",
};
const WORKLOG = {
  id: "20",
  issueId: "10001",
  timeSpentSeconds: 1200,
  comment: "Reviewed the change",
  started: "2026-11-07T12:00:00.000+0000",
  author: { name: "reader", displayName: "Reader", emailAddress: "omit@example.invalid" },
  self: "https://untrusted.invalid/log",
};
function response(body: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome {
  return { ok: true, status, body };
}
function fixture(
  overrides: Readonly<Record<string, AtlassianWriteHttpOutcome>> = {},
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path) =>
    Promise.resolve(
      overrides[path] ??
        {
          issueLinkType: response({ issueLinkTypes: [TYPE] }),
          "issueLink/30": response({
            id: "30",
            type: TYPE,
            inwardIssue: { id: "10001", key: "APP-1" },
            outwardIssue: { id: "10002", key: "APP-2" },
          }),
          "issue/APP-1?fields=summary": response({ id: "10001", key: "APP-1" }),
          "issue/10001/worklog": response({
            worklogs: [WORKLOG],
            total: 1,
            startAt: 0,
            maxResults: 1,
          }),
          "issue/10001/worklog/20": response(WORKLOG),
        }[path] ?? { ok: false, reason: "not-found" },
    ),
  );
}

describe("closed native issue detail reads", () => {
  it("projects and locally pages native link types without transport URLs", async () => {
    const request = fixture();
    expect(
      await executeJiraIssueDetailRead("jira.link-types", { startAt: 0, maxResults: 1 }, request),
    ).toEqual({
      data: {
        outcome: "succeeded",
        items: [{ id: "10", name: "Blocks", inward: "is blocked by", outward: "blocks" }],
        startAt: 0,
        total: 1,
      },
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual(["issueLinkType"]);
  });
  it("reads the exact link identity with both native relationship directions", async () => {
    const request = fixture();
    expect(
      (await executeJiraIssueDetailRead("jira.issue-link", { linkId: "30" }, request)).data,
    ).toEqual({
      outcome: "succeeded",
      items: [
        {
          id: "30",
          name: "Blocks",
          inward: "is blocked by",
          outward: "blocks",
          inwardIssueKey: "APP-1",
          outwardIssueKey: "APP-2",
        },
      ],
    });
  });
  it("binds complete worklog collections to the selected issue and locally pages them", async () => {
    const request = fixture();
    const result = await executeJiraIssueDetailRead(
      "jira.worklogs",
      { issueKey: "APP-1", maxResults: 1 },
      request,
    );
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      total: 1,
      items: [
        {
          id: "20",
          issueKey: "APP-1",
          timeSpentSeconds: 1200,
          authorName: "reader",
          authorDisplayName: "Reader",
        },
      ],
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "issue/APP-1?fields=summary",
      "issue/10001/worklog",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/untrusted|emailAddress|omit@example/u);
  });
  it("reads the exact worklog without converting its identity to a number", async () => {
    expect(
      (
        await executeJiraIssueDetailRead(
          "jira.worklog",
          { issueKey: "APP-1", worklogId: "20" },
          fixture(),
        )
      ).data,
    ).toMatchObject({ outcome: "succeeded", items: [{ id: "20", timeSpentSeconds: 1200 }] });
  });
  it("refuses incomplete native worklogs instead of inventing a complete zero or remote cursor", async () => {
    const request = fixture({
      "issue/10001/worklog": response({ worklogs: [], total: 1, startAt: 0, maxResults: 0 }),
    });
    expect(
      (await executeJiraIssueDetailRead("jira.worklogs", { issueKey: "APP-1" }, request)).data,
    ).toMatchObject({ outcome: "failed", reason: "bounds-exceeded" });
  });
  it.each([
    ["issueId", "10002"],
    ["timeSpentSeconds", -1],
    ["timeSpentSeconds", "1200"],
    ["timeSpentSeconds", 9007199254740992],
    ["id", "21"],
  ] as const)("refuses invalid worklog %s", async (field, value) => {
    const request = fixture({ "issue/10001/worklog/20": response({ ...WORKLOG, [field]: value }) });
    expect(
      (
        await executeJiraIssueDetailRead(
          "jira.worklog",
          { issueKey: "APP-1", worklogId: "20" },
          request,
        )
      ).data.outcome,
    ).toBe("failed");
  });
  it("refuses duplicate native link identities", async () => {
    const request = fixture({ issueLinkType: response({ issueLinkTypes: [TYPE, TYPE] }) });
    expect((await executeJiraIssueDetailRead("jira.link-types", {}, request)).data.outcome).toBe(
      "failed",
    );
  });
  it("refuses model-selected paths before transport", async () => {
    const request = fixture();
    expect(
      (
        await executeJiraIssueDetailRead(
          "jira.issue-link",
          { linkId: "30", url: "https://untrusted.invalid" },
          request,
        )
      ).data.outcome,
    ).toBe("failed");
    expect(request).not.toHaveBeenCalled();
  });
});
