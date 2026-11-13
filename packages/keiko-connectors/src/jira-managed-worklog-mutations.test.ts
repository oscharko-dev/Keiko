import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraObjectMutationBody } from "./jira-test-request/_support.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import {
  executeJiraWorklogMutation,
  isJiraWorklogMutation,
} from "./jira-managed-worklog-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const CREATE = {
  issueKey: "SYN-1",
  timeSpentSeconds: 1200,
  started: "2026-11-07T10:00:00Z",
  comment: "Investigated",
  visibility: { type: "role", value: "Developers" },
};
const ID = "9007199254740993";
const ISSUE = {
  id: "10001",
  key: "SYN-1",
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
  started: "2026-11-07T10:00:00.000+0000",
  timeSpentSeconds: 1200,
  comment: "Investigated",
  visibility: CREATE.visibility,
};
const UPDATE = { issueKey: "SYN-1", worklogId: ID, comment: "Updated" };
const RECEIPT = { issueKey: "SYN-1", issueId: ISSUE.id, worklogId: ID };
const PATH = `issue/${ISSUE.id}/worklog/${ID}`;
const ok = (body: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome => ({
  ok: true,
  status,
  body,
});
function fixture(
  options: {
    readonly issue?: Record<string, unknown>;
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly write?: AtlassianWriteHttpOutcome;
    readonly readFailure?: AtlassianWriteHttpOutcome;
    readonly throws?: boolean;
  } = {},
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  let current = options.before ?? WORKLOG;
  function read(path: string): AtlassianWriteHttpOutcome {
    if (path.startsWith("issue/") && path.includes("?fields=")) return ok(options.issue ?? ISSUE);
    expect(path).toBe(PATH);
    if (written && options.throws) throw new TypeError("Readback interrupted");
    return written ? (options.readFailure ?? ok(options.after ?? current)) : ok(current);
  }
  return vi.fn<JiraMutationRequest>((path, method = "GET", body) => {
    if (method !== "GET") {
      expect(path).toBe(
        `${method === "POST" ? `issue/${ISSUE.id}/worklog` : PATH}?adjustEstimate=leave`,
      );
      written = true;
      current = { ...current, ...jiraObjectMutationBody(body) };
      return Promise.resolve(options.write ?? ok(current, method === "POST" ? 201 : 200));
    }
    return Promise.resolve(read(path));
  });
}
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
const create = (
  request: JiraMutationRequest,
  args: CatalogJsonObject = CREATE,
  templates?: JiraIssueTemplateSource,
): ReturnType<typeof executeJiraWorklogMutation> =>
  executeJiraWorklogMutation("jira.create-worklog", args, request, false, templates);
const update = (
  request: JiraMutationRequest,
  args: CatalogJsonObject = UPDATE,
  templates?: JiraIssueTemplateSource,
): ReturnType<typeof executeJiraWorklogMutation> =>
  executeJiraWorklogMutation("jira.update-worklog", args, request, false, templates);

describe("native worklog changes with fixed remaining estimates", () => {
  it.each(["syn-1", "10001"])(
    "retains the observed canonical key for input %s",
    async (issueKey) => {
      expect(await create(fixture(), { ...CREATE, issueKey })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
      expect(await update(fixture(), { ...UPDATE, issueKey })).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it("creates once using the bound issue ID, explicit leave, exact int64 worklog receipt and independent GET", async () => {
    const request = fixture();
    expect(await create(request)).toEqual({ ok: true, receipt: RECEIPT });
    expect(request.mock.calls).toEqual([
      ["issue/SYN-1?fields=summary%2Ctimespent%2Ctimetracking"],
      [
        `issue/${ISSUE.id}/worklog?adjustEstimate=leave`,
        "POST",
        {
          timeSpentSeconds: 1200,
          started: WORKLOG.started,
          comment: "Investigated",
          visibility: CREATE.visibility,
        },
      ],
      [PATH],
    ]);
  });
  it("updates only requested native fields while retaining visibility and verifying preserved fields", async () => {
    const request = fixture();
    expect(await update(request)).toEqual({ ok: true, receipt: RECEIPT });
    expect(request.mock.calls[2]).toEqual([
      `${PATH}?adjustEstimate=leave`,
      "PUT",
      { comment: "Updated", visibility: CREATE.visibility },
    ]);
    expect(request.mock.calls.at(-1)).toEqual([PATH]);
  });
  it.each([202, 204])(
    "independently confirms a body-free successful %s update acknowledgement",
    async (status) => {
      const request = fixture({ write: { ok: true, status, body: undefined } });
      expect(await update(request)).toEqual({ ok: true, receipt: RECEIPT });
      expect(request.mock.calls.at(-1)).toEqual([PATH]);
      expect(request.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    },
  );
  it("reads the approved update target after a mismatched acknowledgement without changing its identity", async () => {
    const request = fixture({ write: ok({ id: "99" }) });
    expect(await update(request)).toEqual({ ok: false, reason: "conflict", receipt: RECEIPT });
    expect(request.mock.calls.at(-1)).toEqual([PATH]);
    expect(request.mock.calls).toHaveLength(4);
  });
  it.each(["jira.create-worklog", "jira.update-worklog"] as const)(
    "admits preflight for %s without an effect or invented receipt",
    async (operation) => {
      const request = fixture();
      expect(
        await executeJiraWorklogMutation(
          operation,
          operation === "jira.create-worklog" ? CREATE : UPDATE,
          request,
          true,
        ),
      ).toEqual({ ok: true, receipt: {} });
      expect(request.mock.calls.every(([, method]) => method === undefined)).toBe(true);
    },
  );
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "1200", null])(
    "refuses invalid seconds before dispatch",
    async (timeSpentSeconds) => {
      const request = fixture();
      expect(await create(request, { ...CREATE, timeSpentSeconds })).toMatchObject({
        ok: false,
        reason: "field-validation",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "2026-11-07",
    "2026-02-30T10:00:00Z",
    "2026-11-07T10:00:00",
    "2026-11-07T25:00:00Z",
    "x".repeat(41),
  ])("refuses invalid or unzoned started timestamps", async (started) => {
    const request = fixture();
    expect(await create(request, { ...CREATE, started })).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...CREATE, adjustEstimate: "auto" },
    { ...CREATE, comment: "x".repeat(32769) },
    { ...CREATE, comment: "bad\u0000" },
    { ...CREATE, visibility: null },
    { ...CREATE, visibility: { type: "unknown", value: "team" } },
  ])("refuses unsupported native knobs and invalid restricted text", async (args) => {
    const request = fixture();
    expect(await create(request, args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { issueKey: "SYN-1", worklogId: ID },
    { ...UPDATE, worklogId: "01" },
    { ...UPDATE, worklogId: "9223372036854775808" },
    { ...UPDATE, visibility: CREATE.visibility },
  ])("refuses empty updates and ownership/visibility overrides", async (args) => {
    const request = fixture();
    expect(await update(request, args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves native strings and normalizes only line endings for proof", async () => {
    const request = fixture({ after: { ...WORKLOG, comment: "*native*\ntext" } });
    expect(await create(request, { ...CREATE, comment: "*native*\r\ntext" })).toEqual({
      ok: true,
      receipt: RECEIPT,
    });
    expect(jiraObjectMutationBody(request.mock.calls[1]?.[2]).comment).toBe("*native*\r\ntext");
  });
  it("compares started instants and canonicalizes the reviewed timestamp to UTC", async () => {
    const request = fixture();
    expect(await create(request, { ...CREATE, started: "2026-11-07T11:00:00+01:00" })).toEqual({
      ok: true,
      receipt: RECEIPT,
    });
    expect(jiraObjectMutationBody(request.mock.calls[1]?.[2]).started).toBe(WORKLOG.started);
  });
  it.each([undefined, null])(
    "retains an unrestricted worklog without inventing visibility",
    async (visibility) => {
      const request = fixture({ before: { ...WORKLOG, visibility } });
      expect(await update(request)).toEqual({ ok: true, receipt: RECEIPT });
      expect(request.mock.calls[2]?.[2]).toEqual({ comment: "Updated" });
    },
  );
  it.each([{ id: "99" }, { issueId: "99" }, { visibility: { type: "unknown", value: "x" } }])(
    "refuses mismatched identity or unknown restrictions before PUT",
    async (patch) => {
      const request = fixture({ before: { ...WORKLOG, ...patch } });
      expect(await update(request)).toMatchObject({ ok: false });
      expect(request.mock.calls).toHaveLength(2);
    },
  );
  it.each([
    { issueId: "99" },
    { id: "99" },
    { timeSpentSeconds: 1199 },
    { started: "2026-11-06T10:00:00Z" },
    { comment: "different" },
    { visibility: null },
  ])("retains the receipt without claiming a mismatched independent readback", async (patch) => {
    expect(await create(fixture({ after: { ...WORKLOG, ...patch } }))).toMatchObject({
      ok: false,
      receipt: RECEIPT,
    });
  });
  it.each([200, 202])(
    "confirms readable successful %s acknowledgements without losing the created ID",
    async (status) => {
      expect(await create(fixture({ write: ok({ id: ID }, status) }))).toEqual({
        ok: true,
        receipt: RECEIPT,
      });
    },
  );
  it.each(["timeout", "conflict"] as const)(
    "never retries or upgrades a %s mutation failure",
    async (reason) => {
      const request = fixture({ write: { ok: false, reason } });
      expect(await create(request)).toEqual({
        ok: false,
        reason,
        receipt: { issueKey: "SYN-1", issueId: ISSUE.id },
      });
      expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
      expect(request.mock.calls).toHaveLength(2);
    },
  );
  it("retains the acknowledged ID when the independent read fails", async () => {
    expect(await create(fixture({ readFailure: { ok: false, reason: "timeout" } }))).toEqual({
      ok: false,
      reason: "timeout",
      receipt: RECEIPT,
    });
  });
  it("retains acknowledged receipt and original cause when readback throws", async () => {
    await expect(create(fixture({ throws: true }))).rejects.toMatchObject({
      name: JiraAcknowledgedMutationError.name,
      receipt: RECEIPT,
      cause: new TypeError("Readback interrupted"),
    });
  });
  it("uses the explicit unchanged protocol and performs no PUT for equal values", async () => {
    const request = fixture();
    expect(await update(request, { ...UPDATE, comment: WORKLOG.comment })).toMatchObject({
      ok: false,
      reason: "conflict",
      receipt: RECEIPT,
      detail: { unchanged: true },
    });
    expect(request.mock.calls).toHaveLength(2);
  });
  it("applies saved template requirements to the observed post-state", async () => {
    expect(await create(fixture(), CREATE, source())).toEqual({ ok: true, receipt: RECEIPT });
    expect(
      await update(fixture(), { ...UPDATE, timeSpentSeconds: 1800 }, source("timetracking")),
    ).toEqual({ ok: true, receipt: RECEIPT });
  });
  // #4354: a worklog change touches the time fields only; a rule the issue already broke in its
  // summary does not block it.
  it("does not let a saved summary constraint on an untouched field block the change", async () => {
    const request = fixture();
    expect(await create(request, CREATE, source("timespent", "^Required"))).toMatchObject({
      ok: true,
    });
    expect(request.mock.calls.some(([, method]) => method !== undefined)).toBe(true);
  });
  it.each([null, undefined, Number.MAX_SAFE_INTEGER])(
    "does not invent a zero aggregate or overflow to satisfy a saved template",
    async (timespent) => {
      const request = fixture({
        issue: { ...ISSUE, fields: { ...ISSUE.fields, timespent, timetracking: null } },
      });
      expect(await create(request, CREATE, source())).toMatchObject({
        ok: false,
        reason: "field-validation",
        violations: [{ ruleId: "template-unreadable" }],
      });
      expect(request.mock.calls.every(([, method]) => method === undefined)).toBe(true);
    },
  );
  it("does not block template-free work on an unavailable aggregate", async () => {
    const request = fixture({
      issue: { ...ISSUE, fields: { ...ISSUE.fields, timespent: null, timetracking: null } },
    });
    expect(await create(request)).toEqual({ ok: true, receipt: RECEIPT });
  });
  it("refuses an aggregate smaller than the updated worklog instead of inventing a post-state", async () => {
    const request = fixture({
      issue: { ...ISSUE, fields: { ...ISSUE.fields, timespent: 100, timetracking: null } },
    });
    expect(await update(request, { ...UPDATE, timeSpentSeconds: 1300 }, source())).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(request.mock.calls.every(([, method]) => method === undefined)).toBe(true);
  });
  it("refuses unreadable saved templates before effect", async () => {
    const request = fixture();
    expect(await create(request, CREATE, () => ({ templates: [], unreadable: 1 }))).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(request.mock.calls).toHaveLength(1);
  });
  it("jira.update-worklog refuses an unreadable template library before effect", async () => {
    const request = fixture();
    expect(await update(request, UPDATE, () => ({ templates: [], unreadable: 1 }))).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(request.mock.calls.every(([, method]) => method === undefined)).toBe(true);
  });
  it("recognizes only the two closed write names", () => {
    expect(isJiraWorklogMutation("jira.create-worklog")).toBe(true);
    expect(isJiraWorklogMutation("jira.update-worklog")).toBe(true);
    expect(isJiraWorklogMutation("jira.delete-worklog")).toBe(false);
  });
});
