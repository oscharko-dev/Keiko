import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate, type JiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { gateJiraMutationByTemplates, type JiraTemplateGateInput } from "./jira-managed-template-gate.js";

const DESCRIPTION = "h2. Acceptance criteria\n* Observable result";
function savedRule(type: string, rules: readonly string[], body = ""): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate([
    "---", "keiko: jira-issue-template", "version: 1", "project: SYN", `issueType: ${type}`,
    "activateOn: [create, edit, transition]", ...rules, "---", body,
  ].join("\n"));
  if (!parsed.ok) throw new TypeError("The formal fixture must parse");
  return parsed.template;
}
function fields(type = "Task"): Record<string, unknown> {
  return {
    project: { key: "SYN" }, issuetype: { id: "10001", name: type },
    summary: "Native task", description: DESCRIPTION, labels: [], customfield_10016: 3,
    parent: { id: "10002", key: "SYN-2" },
  };
}
function issue(values = fields(), id = "10001"): Record<string, unknown> {
  return { id, key: "SYN-1", fields: values };
}
interface Remote {
  readonly issues?: readonly Record<string, unknown>[];
  readonly project?: Record<string, unknown>;
  readonly projectStatus?: number;
  readonly type?: Record<string, unknown>;
  readonly typeStatus?: number;
}
function transport(remote: Remote = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let reads = 0;
  return vi.fn<JiraMutationRequest>(async (path, method = "GET") => {
    expect(method).toBe("GET");
    if (path.startsWith("project/"))
      return { ok: true, status: remote.projectStatus ?? 200, body: remote.project ?? { id: "10000", key: "SYN" } };
    if (path.startsWith("issuetype/"))
      return { ok: true, status: remote.typeStatus ?? 200, body: remote.type ?? { id: "10001", name: "Task" } };
    if (path === "field")
      return { ok: true, status: 200, body: undefined, items: [{ id: "customfield_10016", name: "Story Points" }] };
    const current = remote.issues?.[reads++] ?? remote.issues?.at(-1) ?? issue();
    expect(path).toMatch(/^issue\/SYN-1\?fields=/u);
    return { ok: true, status: 200, body: current };
  });
}
function admission(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
  operation: JiraTemplateGateInput["operation"] = "edit",
  changed: Readonly<Record<string, unknown>> = {},
  update: JiraTemplateGateInput["validated"]["update"] = {},
): ReturnType<typeof gateJiraMutationByTemplates> {
  return gateJiraMutationByTemplates({
    request, source: () => ({ templates: [template], unreadable: 0 }), operation, metadata: [],
    validated: { fields: changed, update },
    target: operation === "create" ? { projectId: "10000", issueTypeId: "10001" } : { issueKey: "SYN-1" },
    ...(operation === "transition" ? { transition: { id: "31", name: "Start", targetStatusName: "Ready" } } : {}),
  });
}

describe("formal rules bind native creation identities", () => {
  it.each(["Epic", "Task", "Bug"])("checks and accepts corrected %s fields against the observed type", async (type) => {
    const template = savedRule(type, ["summaryMinLength: 10"]);
    const request = transport({ type: { id: "10001", name: type } });
    expect(await admission(request, template, "create", { summary: "short" })).toMatchObject({
      ok: false, reason: "field-validation", violations: [{ ruleId: "summary-too-short" }],
    });
    expect(await admission(request, template, "create", { summary: "Corrected native work" })).toEqual({ ok: true });
  });
  it.each<Remote>([
    { project: { id: "999", key: "SYN" } },
    { project: { key: "SYN" } },
    { projectStatus: 202 },
    { type: { id: "999", name: "Task" } },
    { type: { name: "Task" } },
    { typeStatus: 202 },
  ])("refuses unbound native metadata before a template dry run can be called successful: %j", async (remote) => {
    expect(await admission(transport(remote), savedRule("Task", ["summaryMinLength: 10"]), "create", { summary: "Corrected native work" }))
      .toMatchObject({ ok: false, reason: "malformed-payload", violations: [{ ruleId: "template-unreadable" }] });
  });
});

describe.each(["edit", "transition"] as const)("%s binds the complete native evidence read", (operation) => {
  const template = savedRule("Task", ["requiredFields: [Story Points]"]);
  it.each<readonly [string, Record<string, unknown>]>([
    ["native issue", issue(fields(), "999")],
    ["project", issue({ ...fields(), project: { key: "OTHER" } })],
    ["issue-type ID", issue({ ...fields(), issuetype: { id: "10002", name: "Task" } })],
    ["issue-type name", issue(fields("Bug"))],
  ])("refuses changed %s on the second field read", async (_label, second) => {
    const request = transport({ issues: [issue(), second] });
    expect(await admission(request, template, operation)).toMatchObject({
      ok: false, reason: "conflict", violations: [{ ruleId: "template-unreadable" }],
    });
    expect(request.mock.calls.filter(([path]) => path.startsWith("issue/"))).toHaveLength(2);
  });
  it("allows the same identity with the complete corrected required field", async () => {
    expect(await admission(transport({ issues: [issue(), issue()] }), template, operation)).toEqual({ ok: true });
  });
});

describe("unknown native field evidence never becomes a passing formal rule", () => {
  it.each([{ labels: undefined }, { labels: null }, { labels: "REQ-1" }, { labels: ["REQ-1", 7] }])("does not discard malformed labels $labels", async ({ labels }) => {
    const request = transport({ issues: [issue({ ...fields(), labels })] });
    expect(await admission(request, savedRule("Task", ["labelsPattern: ^REQ-[0-9]+$"]))).toMatchObject({
      ok: false, reason: "field-validation", violations: [{ ruleId: "template-unreadable", subject: "labels" }],
    });
  });
  it("a partial label add cannot repair an unreadable collection", async () => {
    const request = transport({ issues: [issue({ ...fields(), labels: ["REQ-1", 7] })] });
    expect(await admission(request, savedRule("Task", ["labelsPattern: ^REQ-[0-9]+$"]), "edit", {}, { labels: [{ add: "REQ-2" }] }))
      .toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable", subject: "labels" }] });
  });
  it.each([{ labels: [] }, { labels: ["REQ-1"] }])("keeps a complete native label collection $labels", async ({ labels }) => {
    expect(await admission(transport({ issues: [issue({ ...fields(), labels })] }), savedRule("Task", ["labelsPattern: ^REQ-[0-9]+$"])))
      .toEqual({ ok: true });
  });
  it("evaluates an explicit complete label replacement instead of unreadable prior labels", async () => {
    const template = savedRule("Task", ["labelsPattern: ^REQ-[0-9]+$"]);
    const request = transport({ issues: [issue({ ...fields(), labels: null })] });
    expect(await admission(request, template, "edit", { labels: ["invalid"] })).toMatchObject({
      ok: false, violations: [{ ruleId: "label-pattern" }],
    });
    expect(await admission(request, template, "edit", { labels: ["REQ-2"] })).toEqual({ ok: true });
  });
  it.each([undefined, null, 4])("does not satisfy a summary maximum with unreadable text %j", async (summary) => {
    const request = transport({ issues: [issue({ ...fields(), summary })] });
    expect(await admission(request, savedRule("Task", ["summaryMaxLength: 30"]))).toMatchObject({
      ok: false, violations: [{ ruleId: "template-unreadable", subject: "summary" }],
    });
    expect(await admission(request, savedRule("Task", ["summaryMaxLength: 30"]), "edit", { summary: "Corrected task" })).toEqual({ ok: true });
  });
  it.each([undefined, 4])("does not reinterpret unreadable description %j as an empty native text", async (description) => {
    const request = transport({ issues: [issue({ ...fields(), description })] });
    const template = savedRule("Task", [], "## Acceptance criteria\n");
    expect(await admission(request, template)).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable", subject: "description" }] });
    expect(await admission(request, template, "edit", { description: DESCRIPTION })).toEqual({ ok: true });
  });
  it("keeps native null description a known missing section", async () => {
    expect(await admission(transport({ issues: [issue({ ...fields(), description: null })] }), savedRule("Task", [], "## Acceptance criteria\n")))
      .toMatchObject({ ok: false, violations: [{ ruleId: "section-missing" }] });
  });
  it.each([{ fields: { summary: "Not a native parent identity" } }, "SYN-2", { id: false }, { key: "SYN-2", id: false }])("refuses unbound native parent %j", async (parent) => {
    expect(await admission(transport({ issues: [issue({ ...fields(), parent })] }), savedRule("Task", ["parentField: parent"])))
      .toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable", subject: "parent" }] });
  });
  it.each([{ id: "10002" }, { key: "SYN-2" }])("retains a bound native parent reference %j", async (parent) => {
    expect(await admission(transport({ issues: [issue({ ...fields(), parent })] }), savedRule("Task", ["parentField: parent"]))).toEqual({ ok: true });
  });
  it("refuses a known absent parent under its saved rule", async () => {
    expect(await admission(transport({ issues: [issue({ ...fields(), parent: null })] }), savedRule("Task", ["parentField: parent"])))
      .toMatchObject({ ok: false, violations: [{ ruleId: "parent-missing" }] });
  });
});
