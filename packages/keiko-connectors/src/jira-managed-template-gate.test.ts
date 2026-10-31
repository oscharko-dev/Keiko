import { describe, expect, it, vi } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";
import {
  checkJiraManagedMutationTemplates,
  executeJiraManagedMutation,
} from "./jira-managed-mutations.js";
import { field, response } from "../../../tests/support/jira-managed-remote.js";

const SECTIONS = "## Context\n## Acceptance criteria\n";
const FULL_DESCRIPTION = "## Context\nWhy\n## Acceptance criteria\n* works";

function named(id: string, type: string, name: string, required = false): Record<string, unknown> {
  return { ...field(id, type, required), name };
}
const CREATE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  named("summary", "string", "Summary", true),
  {
    ...named("description", "string", "Description"),
    schema: { type: "string", system: "description" },
  },
  {
    ...named("customfield_10016", "number", "Story Points"),
    schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  },
];
const EDIT_FIELDS = {
  summary: named("summary", "string", "Summary"),
  description: {
    ...named("description", "string", "Description"),
    schema: { type: "string", system: "description" },
  },
};

function template(frontMatter: readonly string[], body = SECTIONS): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      ...frontMatter,
      "---",
      body,
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}
const ALL_POINTS = ["activateOn: [create, edit, transition:Ready]"];

interface ReadRoute {
  readonly suffix?: string;
  readonly includes?: string;
  readonly body: unknown;
  readonly status?: number;
}
function readRoutes(remote: Remote): readonly ReadRoute[] {
  return [
    { suffix: "/project/10000", body: { key: "SYN" } },
    { suffix: "/issuetype/10001", body: { id: "10001", name: "Story" } },
    {
      includes: "createmeta",
      body: { values: CREATE_FIELDS, start: 0, size: 100, last: true, total: CREATE_FIELDS.length },
    },
    { suffix: "editmeta", body: { fields: EDIT_FIELDS } },
    {
      suffix: "/transitions",
      body: {
        transitions: [
          { id: "31", name: "Start", to: { id: "3", name: "Ready" }, fields: {} },
          { id: "41", name: "Park", to: { id: "4", name: "Parked" }, fields: {} },
        ],
      },
    },
    remote.fieldCatalog
      ? { suffix: "/field", body: [{ id: "customfield_10016", name: "Story Points" }] }
      : { suffix: "/field", body: {}, status: 404 },
    { suffix: "/issue/SYN-1", body: { id: "10001", key: "SYN-1", fields: remote.issue } },
  ];
}
interface Remote {
  issue: Record<string, unknown>;
  fieldCatalog: boolean;
}
function fixture(
  templates: JiraIssueTemplateSet | (() => JiraIssueTemplateSet) | undefined,
  remote: Remote = {
    issue: {
      project: { key: "SYN" },
      issuetype: { id: "10001", name: "Story" },
      status: { id: "1", name: "To Do" },
      summary: "Original summary",
      description: FULL_DESCRIPTION,
      labels: [],
      issuelinks: [],
    },
    fieldCatalog: true,
  },
): {
  http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  writes: () => string[];
  paths: () => string[];
  run: (
    op: JiraMutationOperation,
    args: CatalogJsonObject,
  ) => ReturnType<typeof executeJiraManagedMutation>;
  check: (
    op: JiraMutationOperation,
    args: CatalogJsonObject,
  ) => ReturnType<typeof checkJiraManagedMutationTemplates>;
} {
  const reads = readRoutes(remote);
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      return Promise.resolve(
        path.endsWith("/issue")
          ? response({ key: "SYN-1", id: "10001" }, 201)
          : response(undefined, 204),
      );
    }
    const match = reads.find(
      (route) =>
        (route.suffix !== undefined && path.endsWith(route.suffix)) ||
        (route.includes !== undefined && path.includes(route.includes)),
    );
    return Promise.resolve(
      match === undefined ? response({}, 404) : response(match.body, match.status),
    );
  });
  const context = {
    invocationId: "synthetic",
    correlationId: "synthetic",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
    ...(templates === undefined
      ? {}
      : {
          issueTemplates: (): JiraIssueTemplateSet =>
            typeof templates === "function" ? templates() : templates,
        }),
  };
  const lines = (): string[] =>
    http.mock.calls.map(([request]) => `${request.method} ${new URL(request.url).pathname}`);
  return {
    http,
    paths: lines,
    writes: () => lines().filter((line) => !line.startsWith("GET")),
    run: (op, args) => executeJiraManagedMutation(op, args, context, connection),
    check: (op, args) => checkJiraManagedMutationTemplates(op, args, context, connection),
  };
}

const CREATE = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "Add login flow", description: FULL_DESCRIPTION },
};
const SET = (...templates: JiraIssueTemplate[]): JiraIssueTemplateSet => ({
  templates,
  unreadable: 0,
});

describe("create", () => {
  it("refuses a violating create with structured violations and never writes", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])));
    const result = await f.run("jira.create", {
      ...CREATE,
      fields: { summary: "x", description: "## Context\nWhy" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [
        { ruleId: "section-missing", subject: "Acceptance criteria", template: "SYN/Story" },
        { ruleId: "field-missing", subject: "Story Points", template: "SYN/Story" },
      ],
    });
    expect(f.writes()).toEqual([]);
  });

  it("creates when the write conforms", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])));
    await f.run("jira.create", {
      ...CREATE,
      fields: { ...CREATE.fields, customfield_10016: 3 },
    });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });

  it("changes nothing and reads nothing extra when no template is configured", async () => {
    for (const templates of [undefined, SET()]) {
      const f = fixture(templates);
      await f.run("jira.create", CREATE);
      expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
      expect(f.paths().some((line) => line.includes("/project/"))).toBe(false);
    }
  });

  it("ignores a template of another project, another issue type or another activation point", async () => {
    const other = { ...template(ALL_POINTS), project: "OTHER" };
    const bug = { ...template(ALL_POINTS), issueType: "Bug" };
    const editOnly = template(["activateOn: [edit]"]);
    const f = fixture(SET(other, bug, editOnly));
    await f.run("jira.create", { ...CREATE, fields: { summary: "x" } });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });

  it("fails closed when a stored template no longer parses", async () => {
    const f = fixture({ templates: [], unreadable: 1 });
    expect(await f.run("jira.create", CREATE)).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-unreadable", subject: "template library", template: "*" }],
    });
    expect(f.http).not.toHaveBeenCalledWith(expect.objectContaining({ method: "POST" }));
  });

  it("fails closed, without writing, when the template source throws", async () => {
    const f = fixture(() => {
      throw new Error("store unavailable");
    });
    await expect(f.run("jira.create", CREATE)).rejects.toThrow("store unavailable");
    expect(f.writes()).toEqual([]);
  });

  it("refuses a field the create screen cannot carry as unavailable", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Does not exist]"])));
    const result = await f.run("jira.create", CREATE);
    expect(result).toMatchObject({
      ok: false,
      violations: [{ ruleId: "field-unavailable", subject: "Does not exist" }],
    });
    expect(f.writes()).toEqual([]);
  });
});

describe("edit", () => {
  const rules = [...ALL_POINTS, "summaryMinLength: 10", "requiredFields: [Story Points]"];

  it("checks the state after the edit, merging the issue's current values", async () => {
    const f = fixture(SET(template(rules)), {
      fieldCatalog: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        summary: "Original summary",
        description: FULL_DESCRIPTION,
        labels: [],
        customfield_10016: 5,
      },
    });
    await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "A longer summary" } });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
  });

  it("refuses an edit that leaves the issue violating, naming the violation", async () => {
    const f = fixture(SET(template(rules)));
    const result = await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } });
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [
        { ruleId: "summary-too-short" },
        { ruleId: "field-missing", subject: "Story Points" },
      ],
    });
    expect(f.writes()).toEqual([]);
  });

  it("falls back to the instance field list when a name is not on the edit screen", async () => {
    const f = fixture(SET(template(rules)), {
      fieldCatalog: false,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        summary: "Original summary",
        description: FULL_DESCRIPTION,
      },
    });
    expect(
      await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "A longer summary" } }),
    ).toMatchObject({ violations: [{ ruleId: "field-unavailable", subject: "Story Points" }] });
    expect(f.writes()).toEqual([]);
  });

  it("does not govern an issue of another type", async () => {
    const f = fixture(SET(template(rules)), {
      fieldCatalog: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10002", name: "Bug" },
        summary: "Original summary",
      },
    });
    await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
  });
});

describe("transition", () => {
  const gated = template(
    ["activateOn: [transition:Ready]", "requiredFields: [Story Points]"],
    "# T",
  );

  it("refuses a transition into the activating status until the issue conforms", async () => {
    const f = fixture(SET(gated));
    const result = await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "31" });
    expect(result).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "field-missing", subject: "Story Points", template: "SYN/Story" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("lets a conforming issue through", async () => {
    const f = fixture(SET(gated), {
      fieldCatalog: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        status: { id: "1", name: "To Do" },
        customfield_10016: 8,
      },
    });
    await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "31" });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue/SYN-1/transitions"]);
  });

  it("does not activate for a transition into another status", async () => {
    const f = fixture(SET(gated));
    await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "41" });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue/SYN-1/transitions"]);
  });
});

describe("dry run before approval", () => {
  it("reports violations and performs no write", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    expect(
      await f.check("jira.create", { ...CREATE, fields: { summary: "x", description: "" } }),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.writes()).toEqual([]);
  });

  it("passes a conforming write without writing", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    expect(await f.check("jira.create", CREATE)).toEqual({ ok: true });
    expect(f.writes()).toEqual([]);
  });

  it("leaves other failures to the executor", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    expect(await f.check("jira.create", { projectId: "x", issueTypeId: "y", fields: {} })).toEqual({
      ok: true,
    });
    expect(await f.check("jira.comment", { issueKey: "SYN-1", body: "hi" })).toEqual({ ok: true });
  });
});

describe("operations without field state", () => {
  it("never consults templates for assign and comment", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    await f.run("jira.comment", { issueKey: "SYN-1", body: "hello" });
    expect(f.paths().some((line) => line.includes("/project/"))).toBe(false);
  });
});
