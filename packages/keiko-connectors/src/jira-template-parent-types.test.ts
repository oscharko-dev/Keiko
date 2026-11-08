import { describe, expect, it, vi } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraMutationByTemplates,
  gateJiraSchemaRuleImpact,
  type JiraTemplateGateInput,
} from "./jira-managed-template-gate.js";
import {
  checkJiraIssueTemplate,
  validateJiraIssueTemplateAgainstInstance,
} from "./jira-issue-template-check.js";
import { readJiraTemplateInstanceMetadata } from "./jira-issue-template-instance.js";
import { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";

function rule(types = "Task"): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Sub-task",
      "activateOn: [create, edit, transition]",
      "parentField: parent",
      `parentIssueTypes: [${types}]`,
      "---",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("The saved parent-type fixture must parse");
  return parsed.template;
}
const PARENT = { id: "10002", key: "SYN-2", fields: { issuetype: { id: "7", name: "Task" } } };
function respond(
  parent: Record<string, unknown> | "denied",
  path: string,
  method: string,
): AtlassianWriteHttpOutcome {
  expect(method).toBe("GET");
  if (path === "project/10000") return { ok: true, status: 200, body: { id: "10000", key: "SYN" } };
  if (path === "issuetype/10003")
    return { ok: true, status: 200, body: { id: "10003", name: "Sub-task" } };
  if (path.startsWith("issue/SYN-1?"))
    return {
      ok: true,
      status: 200,
      body: {
        id: "10001",
        key: "SYN-1",
        fields: {
          project: { key: "SYN" },
          issuetype: { id: "10003", name: "Sub-task" },
          parent: { id: "10002", key: "SYN-2" },
          issuelinks: [],
        },
      },
    };
  expect(path).toMatch(/^issue\/(?:10002|SYN-2)\?fields=issuetype$/u);
  return parent === "denied"
    ? { ok: false, reason: "permission-denied" }
    : { ok: true, status: 200, body: parent };
}
function fixture(
  parent: Record<string, unknown> | "denied" = PARENT,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path, method = "GET") =>
    Promise.resolve(respond(parent, path, method)),
  );
}
function gate(
  request: JiraMutationRequest,
  template = rule(),
  parent: unknown = { key: "SYN-2" },
  operation: JiraTemplateGateInput["operation"] = "create",
): ReturnType<typeof gateJiraMutationByTemplates> {
  return gateJiraMutationByTemplates({
    request,
    source: () => ({ templates: [template], unreadable: 0 }),
    operation,
    metadata: [],
    validated: { fields: { parent }, update: {} },
    target:
      operation === "create" ? { projectId: "10000", issueTypeId: "10003" } : { issueKey: "SYN-1" },
    ...(operation === "transition" ? { transition: { id: "31" } } : {}),
  });
}

describe("native parent issue-type admission", () => {
  it.each(["create", "edit", "transition"] as const)(
    "%s independently accepts a Task parent and refuses an Epic parent",
    async (operation) => {
      const good = fixture();
      expect(await gate(good, rule(), { key: "SYN-2" }, operation)).toEqual({ ok: true });
      expect(good).toHaveBeenCalledWith("issue/SYN-2?fields=issuetype");
      const wrong = fixture({ ...PARENT, fields: { issuetype: { id: "8", name: "Epic" } } });
      expect(await gate(wrong, rule(), { key: "SYN-2" }, operation)).toMatchObject({
        ok: false,
        reason: "field-validation",
        violations: [{ ruleId: "parent-type-mismatch", subject: "parent: Task" }],
      });
      expect(wrong.mock.calls.every(([, method]) => method === undefined || method === "GET")).toBe(
        true,
      );
    },
  );
  it.each(["task", "7"])(
    "matches independently observed native name or exact ID: %s",
    async (allowed) => {
      expect(await gate(fixture(), rule(allowed), "SYN-2")).toEqual({ ok: true });
    },
  );
  it.each([
    { ...PARENT, id: "999", key: "OTHER-9" },
    { ...PARENT, fields: {} },
    { ...PARENT, fields: { issuetype: { name: "Task" } } },
    { ...PARENT, fields: { issuetype: { id: "7" } } },
    { ...PARENT, fields: { issuetype: { id: "7", name: "" } } },
  ])("refuses changed identity or missing native type evidence", async (parent) => {
    expect(await gate(fixture(parent))).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
  });
  it("does not trust embedded type hints or a contradictory second parent identity", async () => {
    const epic = fixture({ ...PARENT, fields: { issuetype: { id: "8", name: "Epic" } } });
    expect(
      await gate(epic, rule(), { key: "SYN-2", fields: { issuetype: { id: "7", name: "Task" } } }),
    ).toMatchObject({ ok: false, violations: [{ ruleId: "parent-type-mismatch" }] });
    expect(await gate(fixture(), rule(), { id: "10002", key: "OTHER-9" })).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
  });
  it("keeps permission-denied parent evidence unknown and legacy presence-only rules unchanged", async () => {
    expect(await gate(fixture("denied"))).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
    const legacy = rule();
    const request = fixture("denied");
    expect(await gate(request, { ...legacy, parent: { field: "parent" } })).toEqual({ ok: true });
    expect(request.mock.calls.some(([path]) => path.startsWith("issue/"))).toBe(false);
  });
  it("retains missing-parent refusal and performs no parent GET for malformed composite selectors", async () => {
    expect(await gate(fixture(), rule(), null)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "parent-missing" }],
    });
    const request = fixture();
    expect(await gate(request, rule(), [{ key: "SYN-2" }])).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
    expect(request.mock.calls.some(([path]) => path.startsWith("issue/"))).toBe(false);
  });
  it("does not turn prose instructions into a parent-type gate", async () => {
    const request = vi.fn<JiraMutationRequest>();
    expect(
      await gateJiraMutationByTemplates({
        request,
        source: () => ({ templates: [], unreadable: 0 }),
        operation: "create",
        metadata: [],
        validated: { fields: { parent: { key: "SYN-2" } }, update: {} },
        target: { projectId: "10000", issueTypeId: "10003" },
      }),
    ).toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
  });
  it("does not mistake an embedded parent type for report/compliance evidence", async () => {
    const template = rule();
    const fields = { parent: PARENT };
    expect(
      checkJiraIssueTemplate(
        template,
        { operation: "create", projectKey: "SYN", issueType: { name: "Sub-task" }, fields },
        [{ id: "parent", name: "Parent" }],
      ),
    ).toMatchObject([{ ruleId: "template-unreadable" }]);
    const checker = createJiraReportTemplateChecker(() => ({
      templates: [template],
      unreadable: 0,
    })).bind([]);
    if (typeof checker === "string") throw new TypeError("Expected bound parent checker");
    expect(
      await checker.check({
        key: "SYN-1",
        projectKey: "SYN",
        issueTypeId: "10003",
        typeName: "Sub-task",
        category: "new",
        fields,
      }),
    ).toBe("unavailable");
    const legacy = { ...template, parent: { field: "parent" } };
    expect(
      createJiraReportTemplateChecker(() => ({ templates: [legacy], unreadable: 0 })).bind([]),
    ).not.toBe("unavailable");
  });
  it("includes allowed parent types in existing type-migration impact admission", async () => {
    expect(
      await gateJiraSchemaRuleImpact({
        request: fixture(),
        source: () => ({ templates: [rule()], unreadable: 0 }),
        impact: { kind: "issue-type", types: [{ id: "7", name: "Task" }] },
      }),
    ).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
  });
});

describe("native validation of a saved parent-type clause", () => {
  it("reports an oversized native parent-type catalog as a bounds failure", async () => {
    const request = vi.fn<JiraMutationRequest>((path) =>
      Promise.resolve<AtlassianWriteHttpOutcome>(
        path === "project/SYN"
          ? { ok: true, status: 200, body: { id: "10000", key: "SYN", issueTypes: [] } }
          : {
              ok: true,
              status: 200,
              body: undefined,
              items: Array.from({ length: 1001 }, (_, index) => ({
                id: String(index + 1),
                name: "Task",
              })),
            },
      ),
    );
    expect(await readJiraTemplateInstanceMetadata(request, rule())).toEqual({
      ok: false,
      reason: "bounds-exceeded",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("uses the global type catalog, not the child project's available types, and never defaults unknown IDs", async () => {
    const request = vi.fn<JiraMutationRequest>((path) => {
      if (path === "project/SYN")
        return Promise.resolve<AtlassianWriteHttpOutcome>({
          ok: true,
          status: 200,
          body: { id: "10000", key: "SYN", issueTypes: [{ id: "10003", name: "Sub-task" }] },
        });
      if (path === "issuetype")
        return Promise.resolve<AtlassianWriteHttpOutcome>({
          ok: true,
          status: 200,
          body: undefined,
          items: [{ id: "7", name: "Task" }],
        });
      return Promise.resolve<AtlassianWriteHttpOutcome>({
        ok: false,
        reason: "permission-denied",
      });
    });
    const read = await readJiraTemplateInstanceMetadata(request, rule());
    if (!read.ok) throw new TypeError("Expected independently read validation metadata");
    expect(validateJiraIssueTemplateAgainstInstance(rule(), read.instance)).toEqual([]);
    expect(validateJiraIssueTemplateAgainstInstance(rule("99"), read.instance)).toContainEqual({
      code: "unknown-issue-type",
      subject: "parentIssueTypes: 99",
    });
    expect(request).toHaveBeenCalledWith("issuetype", "GET", undefined, "json-array");
  });
  it("refuses unavailable global type metadata instead of displaying a successful validation", async () => {
    const request = vi.fn<JiraMutationRequest>((path) =>
      Promise.resolve<AtlassianWriteHttpOutcome>(
        path === "project/SYN"
          ? { ok: true, status: 200, body: { id: "10000", key: "SYN", issueTypes: [] } }
          : { ok: false, reason: "permission-denied" },
      ),
    );
    expect(await readJiraTemplateInstanceMetadata(request, rule())).toEqual({
      ok: false,
      reason: "permission-denied",
    });
  });
});
