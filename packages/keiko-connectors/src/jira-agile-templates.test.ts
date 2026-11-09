import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import {
  checkJiraManagedMutationTemplates,
  executeJiraManagedMutation,
} from "./jira-managed-mutations.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";

function response(body: unknown, status = 200): AtlassianHttpBodyResult {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}
function mutationResponse(
  path: string,
  bodyJson: string | undefined,
  epic: object,
): AtlassianHttpBodyResult {
  return path.endsWith("/issue")
    ? response(undefined, 204)
    : response({ ...epic, ...JSON.parse(bodyJson ?? "{}") });
}
function fixture(
  summary: string,
  sprintRequired = false,
): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly run: (
    operation: Parameters<typeof executeJiraManagedMutation>[0],
    args: Parameters<typeof executeJiraManagedMutation>[1],
  ) => ReturnType<typeof executeJiraManagedMutation>;
  readonly check: (
    operation: Parameters<typeof executeJiraManagedMutation>[0],
    args: Parameters<typeof executeJiraManagedMutation>[1],
  ) => ReturnType<typeof checkJiraManagedMutationTemplates>;
} {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: APP",
      "issueType: Story",
      "activateOn: [edit]",
      "summaryPattern: ^Approved",
      ...(sprintRequired ? ["requiredFields: [Sprint]"] : []),
      "---",
      "",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Fixture template must parse");
  const sprint = { id: 9, name: "Next", state: "future" };
  const epic = { id: 11, key: "APP-11", name: "Delivery", summary, done: false };
  let inBacklog = false;
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      if (path.endsWith("/backlog/issue")) inBacklog = true;
      return Promise.resolve(mutationResponse(path, request.bodyJson, epic));
    }
    if (path.endsWith("/rest/api/2/field"))
      return Promise.resolve(
        response([
          {
            id: "customfield_10000",
            name: "Sprint",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
          },
          {
            id: "customfield_10001",
            name: "Epic Link",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
          },
        ]),
      );
    if (path.includes("/rest/api/2/issue/"))
      return Promise.resolve(
        response({
          id: "12",
          key: path.split("/").at(-1),
          fields: {
            project: { key: "APP" },
            issuetype: { id: "1", name: "Story" },
            summary,
            description: "",
            labels: [],
            issuelinks: [],
            customfield_10000: inBacklog ? [] : ["existing"],
          },
        }),
      );
    if (path.endsWith("/sprint/9")) return Promise.resolve(response(sprint));
    if (path.endsWith("/epic/APP-11")) return Promise.resolve(response(epic));
    if (path.includes("/rest/agile/1.0/issue/"))
      return Promise.resolve(
        response({
          id: "12",
          key: path.split("/").at(-1),
          fields: {
            sprint: inBacklog ? null : sprint,
            closedSprints: [],
            epic: { id: 11, key: "APP-11" },
          },
        }),
      );
    return Promise.resolve(response({}, 404));
  });
  const context = {
    invocationId: "agile-template",
    correlationId: "synthetic",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
    issueTemplates: (): JiraIssueTemplateSet => ({ templates: [parsed.template], unreadable: 0 }),
  };
  return {
    http,
    run: (operation, args) => executeJiraManagedMutation(operation, args, context, connection),
    check: (operation, args) =>
      checkJiraManagedMutationTemplates(operation, args, context, connection),
  };
}

describe("Agile issue changes retain the existing issue-template gate", () => {
  it("refuses an epic's proposed summary before POST and permits its corrected summary", async () => {
    const blocked = fixture("Approved existing");
    expect(
      await blocked.run("jira.epic-update", { epicIdOrKey: "APP-11", summary: "Wrong" }),
    ).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "summary-pattern" }],
    });
    expect(blocked.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(
      0,
    );
    const corrected = fixture("Approved correction");
    expect(
      await corrected.run("jira.epic-update", {
        epicIdOrKey: "APP-11",
        summary: "Approved correction",
      }),
    ).toMatchObject({ ok: true });
    expect(corrected.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(
      1,
    );
  });
  it.each(["jira.sprint-move-issues", "jira.epic-move-issues"] as const)(
    "checks every edited issue before %s and permits corrected content",
    async (operation) => {
      const args =
        operation === "jira.sprint-move-issues"
          ? { sprintId: "9", issues: ["APP-12"] }
          : { epicIdOrKey: "APP-11", issues: ["APP-12"] };
      const blocked = fixture("Wrong");
      expect(await blocked.run(operation, args)).toMatchObject({
        ok: false,
        reason: "field-validation",
      });
      expect(blocked.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(
        0,
      );
      const corrected = fixture("Approved membership");
      expect(await corrected.run(operation, args)).toMatchObject({ ok: true });
    },
  );
  it("judges backlog's planned removal rather than the old nonempty Sprint field", async () => {
    const f = fixture("Approved backlog", true);
    expect(await f.run("jira.backlog-move-issues", { issues: ["APP-12"] })).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "field-missing", subject: "Sprint" }],
    });
    expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
    const corrected = fixture("Approved backlog");
    expect(await corrected.run("jira.backlog-move-issues", { issues: ["APP-12"] })).toMatchObject({
      ok: true,
    });
    expect(corrected.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(
      1,
    );
  });
  it("uses the same template admission in the dry run without any effect", async () => {
    const f = fixture("Approved existing");
    expect(
      await f.check("jira.epic-update", { epicIdOrKey: "APP-11", summary: "Wrong" }),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(
      await f.check("jira.epic-update", { epicIdOrKey: "APP-11", summary: "Approved correction" }),
    ).toEqual({ ok: true });
    expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
  });
});

it("bounds parallel issue-template reads and finishes every admission before the batch effect", async () => {
  const f = fixture("Approved issue");
  const original = f.http.getMockImplementation();
  if (original === undefined) throw new TypeError("Missing fixture transport");
  let active = 0;
  let peakBeforeEffect = 0;
  let written = false;
  f.http.mockImplementation(async (request) => {
    if (request.method === "POST") {
      expect(active).toBe(0);
      written = true;
    }
    if (request.method !== "GET" || !request.url.includes("/issue/")) return original(request);
    active += 1;
    if (!written) peakBeforeEffect = Math.max(peakBeforeEffect, active);
    await Promise.resolve();
    const result = await original(request);
    active -= 1;
    return result;
  });
  const issues = Array.from({ length: 9 }, (_, index) => `APP-${String(index + 1)}`);
  expect(await f.run("jira.backlog-move-issues", { issues })).toMatchObject({ ok: true });
  expect(peakBeforeEffect).toBe(4);
  expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
});
