import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { executeJiraWorklogDelete, isJiraWorklogDelete } from "./jira-managed-worklog-delete.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const ID = "9007199254740993";
const INPUT = {
  issueKey: "SYN-7",
  worklogId: ID,
  timeSpentSeconds: 1200,
  started: "2026-11-07T10:00:00Z",
  comment: "Reviewed",
  visibility: { type: "role", value: "Developers" },
};
const ISSUE = {
  id: "10007",
  key: "SYN-7",
  fields: {
    summary: "Approved work",
    project: { key: "SYN" },
    issuetype: { id: "1", name: "Task" },
    timespent: 3600,
    timetracking: {
      timeSpentSeconds: 3600,
      originalEstimateSeconds: 7200,
      remainingEstimateSeconds: 3600,
    },
  },
};
const WORKLOG = {
  id: ID,
  issueId: ISSUE.id,
  timeSpentSeconds: INPUT.timeSpentSeconds,
  started: INPUT.started,
  comment: INPUT.comment,
  visibility: INPUT.visibility,
};
const RECEIPT = { issueKey: ISSUE.key, issueId: ISSUE.id, worklogId: ID };
const PATH = `issue/${ISSUE.id}/worklog`;
const response = (body: Record<string, unknown>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
const collection = (worklogs: readonly unknown[]): Record<string, unknown> => ({
  worklogs,
  startAt: 0,
  maxResults: worklogs.length,
  total: worklogs.length,
});
interface Options {
  readonly issue?: Record<string, unknown>;
  readonly worklog?: Record<string, unknown>;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly afterIssue?: Record<string, unknown>;
  readonly write?: AtlassianWriteHttpOutcome;
  readonly afterFailure?: AtlassianWriteHttpOutcome;
  readonly throwAfter?: boolean;
}
function fixture(options: Options = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let deleted = false;
  function currentCollection(): AtlassianWriteHttpOutcome {
    if (deleted && options.throwAfter) throw new TypeError("Collection read interrupted");
    return deleted
      ? (options.afterFailure ?? response(options.after ?? collection([])))
      : response(options.before ?? collection([options.worklog ?? WORKLOG]));
  }
  function read(path: string): AtlassianWriteHttpOutcome {
    if (path.includes("?fields="))
      return response(deleted ? (options.afterIssue ?? ISSUE) : (options.issue ?? ISSUE));
    if (path === `${PATH}/${ID}`) return response(options.worklog ?? WORKLOG);
    expect(path).toBe(PATH);
    return currentCollection();
  }
  return vi.fn<JiraMutationRequest>((path, method = "GET", _body, codec) => {
    if (method !== "DELETE") return Promise.resolve(read(path));
    expect(path).toBe(`${PATH}/${ID}?adjustEstimate=leave`);
    expect(codec).toBe("none");
    deleted = true;
    return Promise.resolve(options.write ?? { ok: true, status: 204, body: undefined });
  });
}
const remove = (
  request: JiraMutationRequest,
  args: CatalogJsonObject = INPUT,
  templates?: JiraIssueTemplateSource,
  check = false,
): ReturnType<typeof executeJiraWorklogDelete> =>
  executeJiraWorklogDelete("jira.delete-worklog", args, request, check, templates);
function source(required = "timespent", summaryPattern?: string): JiraIssueTemplateSource {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Task",
      "activateOn: [edit]",
      `requiredFields: [${required}]`,
      ...(summaryPattern === undefined ? [] : [`summaryPattern: ${summaryPattern}`]),
      "---",
      "",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Saved template must parse");
  return () => ({ templates: [parsed.template], unreadable: 0 });
}
describe("reviewed worklog deletion with existing completeness and template owners", () => {
  it("retains a canonical platform issue key beyond the Agile project-key bound", async () => {
    const issueKey = `${"S".repeat(40)}-7`;
    const issue = { ...ISSUE, key: issueKey };
    expect(await remove(fixture({ issue, afterIssue: issue }), { ...INPUT, issueKey })).toEqual({
      ok: true,
      receipt: { ...RECEIPT, issueKey },
    });
  });
  it("performs one fixed-estimate DELETE and confirms removal from the complete same-parent collection", async () => {
    const request = fixture();
    expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
    expect(request.mock.calls).toEqual([
      ["issue/SYN-7?fields=summary%2Ctimespent%2Ctimetracking"],
      [`${PATH}/${ID}`],
      [PATH],
      [`${PATH}/${ID}?adjustEstimate=leave`, "DELETE", undefined, "none"],
      ["issue/10007?fields=summary"],
      [PATH],
    ]);
  });
  it.each(["syn-7", "10007"])(
    "retains observed canonical identity for input %s",
    async (issueKey) => {
      expect(await remove(fixture(), { ...INPUT, issueKey })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it("allows a preflight without a mutation or deletion claim", async () => {
    const request = fixture();
    expect(await remove(request, INPUT, undefined, true)).toEqual({ ok: true, receipt: {} });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("binds explicitly unrestricted visibility and empty native comments", async () => {
    expect(
      await remove(fixture({ worklog: { ...WORKLOG, comment: null, visibility: null } }), {
        ...INPUT,
        comment: "",
        visibility: null,
      }),
    ).toEqual({ ok: true, receipt: RECEIPT });
  });
  it("retains a zero-second native worklog truthfully", async () => {
    expect(
      await remove(fixture({ worklog: { ...WORKLOG, timeSpentSeconds: 0 } }), {
        ...INPUT,
        timeSpentSeconds: 0,
      }),
    ).toEqual({ ok: true, receipt: RECEIPT });
  });
  it.each([
    { ...INPUT, worklogId: "01" },
    { ...INPUT, issueKey: "../7" },
    { ...INPUT, timeSpentSeconds: -1 },
    { ...INPUT, timeSpentSeconds: 1.5 },
    { ...INPUT, timeSpentSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...INPUT, started: "2026-11-07" },
    { ...INPUT, comment: "x".repeat(32769) },
    { ...INPUT, visibility: { type: "unknown", value: "x" } },
    { ...INPUT, adjustEstimate: "auto" },
    {
      issueKey: INPUT.issueKey,
      worklogId: ID,
      timeSpentSeconds: 1200,
      started: INPUT.started,
      comment: INPUT.comment,
    },
  ])("refuses absent or invalid reviewed fields before HTTP", async (args) => {
    const request = fixture();
    expect(await remove(request, args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...WORKLOG, timeSpentSeconds: 1300 },
    { ...WORKLOG, started: "2026-11-08T10:00:00Z" },
    { ...WORKLOG, comment: "Changed" },
    { ...WORKLOG, visibility: null },
    { ...WORKLOG, visibility: { type: "group", value: "Developers" } },
    { ...WORKLOG, issueId: "999" },
    { ...WORKLOG, id: "999" },
  ])("refuses identity or reviewed worklog drift before DELETE", async (worklog) => {
    const request = fixture({ worklog });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...collection([WORKLOG]), total: 2 },
    { ...collection([WORKLOG]), startAt: 1 },
    { ...collection([WORKLOG]), maxResults: 0 },
    collection([WORKLOG, WORKLOG]),
    collection([{ ...WORKLOG, issueId: "999" }]),
    {},
  ])("refuses incomplete or inconsistent native collections before effect", async (before) => {
    const request = fixture({ before });
    expect(await remove(request)).toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("requires known membership in the preflight collection", async () => {
    const request = fixture({ before: collection([]) });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("refuses observed field drift between the individual read and complete collection", async () => {
    const request = fixture({ before: collection([{ ...WORKLOG, timeSpentSeconds: 1300 }]) });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("uses the actual response byte budget without inventing native worklog paging", async () => {
    const worklogs = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
      ...WORKLOG,
      id: String(index + 1), comment: "x".repeat(1024),
    }));
    const request = fixture({ before: collection(worklogs) });
    expect(await remove(request)).toMatchObject({ ok: false, reason: "bounds-exceeded" });
    expect(request.mock.calls.every(([path]) => !path.includes("startAt"))).toBe(true);
  });
  it("admits saved templates using observed negative time delta and preserves remaining estimates", async () => {
    expect(await remove(fixture(), INPUT, source())).toEqual({ ok: true, receipt: RECEIPT });
    expect(await remove(fixture(), INPUT, source("timetracking"))).toEqual({
      ok: true,
      receipt: RECEIPT,
    });
  });
  it.each([null, undefined, 100])(
    "never invents zero or negative aggregate time to satisfy a template",
    async (timespent) => {
      const request = fixture({
        issue: { ...ISSUE, fields: { ...ISSUE.fields, timespent, timetracking: null } },
      });
      expect(await remove(request, INPUT, source())).toMatchObject({
        ok: false,
        violations: [{ ruleId: "template-unreadable" }],
      });
      expect(request.mock.calls.every(([, method]) => method !== "DELETE")).toBe(true);
    },
  );
  it("still applies unrelated saved template constraints before deleting", async () => {
    const request = fixture();
    expect(await remove(request, INPUT, source("timespent", "^Required"))).toMatchObject({
      ok: false,
      violations: [{ ruleId: "summary-pattern" }],
    });
    expect(request.mock.calls.every(([, method]) => method !== "DELETE")).toBe(true);
  });
  it.each(["not-found", "permission-denied", "timeout", "conflict"] as const)(
    "does not retry or upgrade a %s mutation",
    async (reason) => {
      const request = fixture({ write: { ok: false, reason } });
      expect(await remove(request)).toEqual({ ok: false, reason, receipt: RECEIPT });
      expect(request).toHaveBeenCalledTimes(4);
    },
  );
  it.each(["not-found", "permission-denied", "auth-failed", "timeout"] as const)(
    "retains unconfirmed deletion when the collection returns %s",
    async (reason) => {
      expect(await remove(fixture({ afterFailure: { ok: false, reason } }))).toEqual({
        ok: false,
        reason,
        receipt: RECEIPT,
      });
    },
  );
  it.each([
    collection([WORKLOG]),
    { ...collection([]), total: 1 },
    { ...collection([]), startAt: 1 },
    {},
  ])("does not confirm from an incomplete or still-containing collection", async (after) => {
    expect(await remove(fixture({ after }))).toMatchObject({ ok: false, receipt: RECEIPT });
  });
  it("does not accept a changed parent identity after acknowledgement", async () => {
    expect(await remove(fixture({ afterIssue: { ...ISSUE, key: "OTHER-7" } }))).toEqual({
      ok: false,
      reason: "conflict",
      receipt: RECEIPT,
    });
  });
  it("preserves the acknowledged identity and cause after a thrown collection read", async () => {
    await expect(remove(fixture({ throwAfter: true }))).rejects.toMatchObject({
      name: JiraAcknowledgedMutationError.name,
      receipt: RECEIPT,
      cause: new TypeError("Collection read interrupted"),
    });
  });
  it("exposes only the closed deletion operation", () => {
    expect(isJiraWorklogDelete("jira.delete-worklog")).toBe(true);
    expect(isJiraWorklogDelete("jira.delete-all-worklogs")).toBe(false);
  });
});

it("confirms exact deletion within a complete byte-bounded native worklog array larger than one thousand", async () => {
  const others = Array.from({ length: 1001 }, (_, index) => ({ ...WORKLOG, id: String(index + 1), comment: "" }));
  const request = fixture({ before: collection([...others, WORKLOG]), after: collection(others) });
  expect(await remove(request)).toEqual({ ok: true, receipt: RECEIPT });
  expect(request.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
  expect(request.mock.calls.every(([path]) => !path.includes("startAt"))).toBe(true);
});
