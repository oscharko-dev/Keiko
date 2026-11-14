import { describe, expect, it, vi } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";
import { gateJiraSchemaRuleImpact } from "./jira-managed-template-gate.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  checkJiraManagedMutationTemplates,
  executeJiraManagedMutation,
} from "./jira-managed-mutations.js";
import { field, LINKS_FIELD, response } from "../../../tests/support/jira-managed-remote.js";

const SECTIONS = "## Context\n## Acceptance criteria\n";
const FULL_DESCRIPTION = "h2. Context\nWhy\nh2. Acceptance criteria\n* works";

function named(id: string, type: string, name: string, required = false): Record<string, unknown> {
  return { ...field(id, type, required), name };
}
const CREATE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  named("parent", "issuelink", "Parent"),
  named("summary", "string", "Summary", true),
  {
    ...named("description", "string", "Description"),
    schema: { type: "string", system: "description" },
  },
  {
    ...named("customfield_10016", "number", "Story Points"),
    schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  },
  LINKS_FIELD,
];
const EDIT_FIELDS = {
  summary: named("summary", "string", "Summary"),
  assignee: named("assignee", "user", "Assignee"),
  description: {
    ...named("description", "string", "Description"),
    schema: { type: "string", system: "description" },
  },
  issuelinks: LINKS_FIELD,
};

function template(
  frontMatter: readonly string[],
  body = SECTIONS,
  issueType = "Story",
): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      `issueType: ${issueType}`,
      ...frontMatter,
      "---",
      body,
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}
const ALL_POINTS = ["activateOn: [create, edit, transition:Ready]"];

describe("schema impacts on saved formal rules", () => {
  const request = (): ReturnType<typeof vi.fn<JiraMutationRequest>> =>
    vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      items: [
        { id: "summary", name: "Summary" },
        { id: "customfield_10016", name: "Story Points" },
        { id: "customfield_10017", name: "Other" },
      ],
    });
  it.each(["create", "edit", "transition:Ready"])(
    "does not limit type-selection migration checks to edit: %s",
    async (activation) => {
      const rule = template([`activateOn: [${activation}]`, "summaryMinLength: 8"]);
      expect(
        await gateJiraSchemaRuleImpact({
          request: request(),
          source: (): JiraIssueTemplateSet => ({ templates: [rule], unreadable: 0 }),
          impact: { kind: "issue-type", types: [{ id: "7", name: "Story" }] },
        }),
      ).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
    },
  );
  it("includes a migration target's rule selection and leaves unrelated types alone", async () => {
    const source = (): JiraIssueTemplateSet => ({
      templates: [template(["activateOn: [transition:Ready]"])],
      unreadable: 0,
    });
    const types = [
      { id: "1", name: "Task" },
      { id: "7", name: "Story" },
    ];
    expect(
      await gateJiraSchemaRuleImpact({
        request: request(),
        source,
        impact: { kind: "issue-type", types },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await gateJiraSchemaRuleImpact({
        request: request(),
        source,
        impact: { kind: "issue-type", types: [{ id: "1", name: "Task" }] },
      }),
    ).toEqual({ ok: true });
  });
  it.each(["requiredFields: [Story Points]", "parentField: Story Points"])(
    "recognizes deleted custom-field references in %s",
    async (line) => {
      const source = (): JiraIssueTemplateSet => ({
        templates: [template(["activateOn: [create]", line])],
        unreadable: 0,
      });
      expect(
        await gateJiraSchemaRuleImpact({
          request: request(),
          source,
          impact: {
            kind: "custom-fields",
            fields: [{ id: "customfield_10016", name: "Story Points" }],
          },
        }),
      ).toMatchObject({ ok: false });
      expect(
        await gateJiraSchemaRuleImpact({
          request: request(),
          source,
          impact: { kind: "custom-fields", fields: [{ id: "customfield_10017", name: "Other" }] },
        }),
      ).toEqual({ ok: true });
    },
  );
  it("refuses required parent-link removal without broadening a prose skill into enforcement", async () => {
    const impact = { kind: "link-type" as const, names: ["Blocks", "blocks", "is blocked by"] };
    expect(
      await gateJiraSchemaRuleImpact({
        request: request(),
        impact,
        source: () => ({
          templates: [template(["activateOn: [create]", "parentLink: Blocks"])],
          unreadable: 0,
        }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await gateJiraSchemaRuleImpact({
        request: request(),
        impact,
        source: () => ({ templates: [], unreadable: 0 }),
      }),
    ).toEqual({ ok: true });
  });
  it("does not downgrade unreadable saved rules to an empty rule set", async () => {
    expect(
      await gateJiraSchemaRuleImpact({
        request: request(),
        impact: { kind: "issue-type", types: [{ id: "7", name: "Story" }] },
        source: () => ({
          templates: [],
          unreadable: 1,
          unreadableNames: ["Synthetic formal record"],
        }),
      }),
    ).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
  });
});

describe("issue deletion impacts on surviving formal references", () => {
  function admission(
    rule: JiraIssueTemplate,
    items: readonly unknown[] = [],
  ): {
    request: ReturnType<typeof vi.fn<JiraMutationRequest>>;
    source: () => JiraIssueTemplateSet;
    impact: { kind: "issue-deletion" };
  } {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: true, status: 200, body: undefined, items });
    return {
      request,
      source: (): JiraIssueTemplateSet => ({ templates: [rule], unreadable: 0 }),
      impact: { kind: "issue-deletion" as const },
    };
  }
  it.each([
    "parentLink: Blocks",
    "parentField: parent",
    "requiredFields: [issuelinks]",
    "requiredFields: [subtasks]",
  ])("refuses an unproved surviving reference: %s", async (line) => {
    expect(
      await gateJiraSchemaRuleImpact(admission(template(["activateOn: [create]", line]))),
    ).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
  });
  it("does not apply the deleted object's content requirements as a surviving field state", async () => {
    const input = admission(
      template([
        "activateOn: [create, transition:Ready]",
        "summaryMinLength: 8",
        "requiredLabels: [reviewed]",
        "requiredFields: [Summary]",
      ]),
    );
    expect(await gateJiraSchemaRuleImpact(input)).toEqual({ ok: true });
    expect(input.request).not.toHaveBeenCalled();
  });
  it("uses observed scalar metadata to establish disjoint impact", async () => {
    const input = admission(template(["activateOn: [edit]", "requiredFields: [Story Points]"]), [
      {
        id: "customfield_10016",
        name: "Story Points",
        schema: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        },
      },
    ]);
    expect(await gateJiraSchemaRuleImpact(input)).toEqual({ ok: true });
    expect(input.request).toHaveBeenCalledWith("field", "GET", undefined, "json-array");
  });
  it.each([undefined, { type: "string", custom: "plugin:issue-picker" }, { type: "issue" }])(
    "does not invent disjointness from opaque/missing issue-reference metadata",
    async (schema) => {
      const input = admission(template(["activateOn: [create]", "parentField: Related Issue"]), [
        {
          id: "customfield_10100",
          name: "Related Issue",
          ...(schema === undefined ? {} : { schema }),
        },
      ]);
      expect(await gateJiraSchemaRuleImpact(input)).toMatchObject({ ok: false });
    },
  );
  it("keeps an unreadable catalog fail-closed while unrelated content rules remain usable", async () => {
    const input = admission(template(["activateOn: [edit]", "requiredFields: [Related Issue]"]));
    input.request.mockResolvedValue({ ok: false, reason: "permission-denied" });
    expect(await gateJiraSchemaRuleImpact(input)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable" }],
    });
  });
  it("does not convert prose-only/no-formal-rule sources into a deletion gate", async () => {
    const request = vi.fn<JiraMutationRequest>();
    expect(
      await gateJiraSchemaRuleImpact({
        request,
        source: () => ({ templates: [], unreadable: 0 }),
        impact: { kind: "issue-deletion" },
      }),
    ).toEqual({ ok: true });
    expect(request).not.toHaveBeenCalled();
  });
});

interface ReadRoute {
  readonly suffix?: string;
  readonly includes?: string;
  readonly body: unknown;
  readonly status?: number;
}
function readRoutes(remote: Remote): readonly ReadRoute[] {
  return [
    { suffix: "/project/10000", body: { id: "10000", key: "SYN" } },
    { suffix: "/issuetype/10001", body: { id: "10001", name: remote.issueTypeName ?? "Story" } },
    {
      includes: "createmeta",
      body: {
        values: remote.createFields ?? CREATE_FIELDS,
        start: 0,
        size: 100,
        last: true,
        total: (remote.createFields ?? CREATE_FIELDS).length,
      },
    },
    { suffix: "editmeta", body: { fields: EDIT_FIELDS } },
    { suffix: "assignable/search", body: [{ name: "alice", active: true }] },
    {
      suffix: "/transitions",
      body: {
        transitions: remote.unnamedTransitions
          ? [
              { id: "31", to: { id: "3" }, fields: {} },
              { id: "41", to: { id: "4" }, fields: {} },
            ]
          : [
              { id: "31", name: "Start", to: { id: "3", name: "Ready" }, fields: {} },
              { id: "41", name: "Park", to: { id: "4", name: "Parked" }, fields: {} },
            ],
      },
    },
    remote.fieldCatalog
      ? { suffix: "/field", body: [{ id: "customfield_10016", name: "Story Points" }] }
      : { suffix: "/field", body: {}, status: 404 },
    { suffix: "/issue/SYN-1", body: { id: "10001", key: "SYN-1", fields: remote.issue } },
    {
      suffix: "/issue/SYN-2",
      body: {
        id: "10002",
        key: "SYN-2",
        fields: { issuetype: remote.parentType ?? { id: "7", name: "Task" } },
      },
    },
  ];
}
interface Remote {
  issue: Record<string, unknown>;
  fieldCatalog: boolean;
  /** Jira answered transitions without transition or status names. */
  unnamedTransitions?: boolean;
  parentType?: { id: string; name: string };
  /** Replaces the create screen, for example with a Data Center Epic's Epic Name. */
  createFields?: readonly Record<string, unknown>[];
  issueTypeName?: string;
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
  it("blocks a disallowed independently read parent type before the real create dispatch", async () => {
    const saved = SET(
      template(["activateOn: [create]", "parentField: parent", "parentIssueTypes: [Task]"]),
    );
    const invalid = fixture(saved, {
      issue: {},
      fieldCatalog: true,
      parentType: { id: "8", name: "Epic" },
    });
    const args = { ...CREATE, fields: { ...CREATE.fields, parent: { key: "SYN-2" } } };
    expect(await invalid.run("jira.create", args)).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "parent-type-mismatch", template: "SYN/Story" }],
    });
    expect(invalid.writes()).toEqual([]);
    const valid = fixture(saved);
    await valid.run("jira.create", args);
    expect(valid.paths()).toContain("GET /context/rest/api/2/issue/SYN-2");
    expect(valid.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });
  it("refuses a violating create with structured violations and never writes", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])));
    const result = await f.run("jira.create", {
      ...CREATE,
      fields: { summary: "x", description: "h2. Context\nWhy" },
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

  it("checks a create that carries several links before the first write, so no link call follows (#4176)", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])));
    const links = [1, 2, 3].map((n) => ({
      type: "Relates",
      direction: "outward",
      issueKey: `SYN-${String(n + 1)}`,
    }));
    const result = await f.run("jira.create", {
      ...CREATE,
      fields: { summary: "x", description: "h2. Context\nWhy" },
      links,
    });
    expect(result).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.writes()).toEqual([]);
    const conforming = await f.run("jira.create", {
      ...CREATE,
      fields: { ...CREATE.fields, customfield_10016: 3 },
      links,
    });
    expect(f.writes()[0]).toBe("POST /context/rest/api/2/issue");
    expect(conforming).toMatchObject({ receipt: { issueKey: "SYN-1" } });
    expect(f.writes()).toContain("POST /context/rest/api/2/issueLink");
  });

  it("creates when the write conforms", async () => {
    const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])));
    await f.run("jira.create", {
      ...CREATE,
      fields: { ...CREATE.fields, customfield_10016: 3 },
    });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });

  // #4354: a creation is sent only when a saved template activated for creating governs the
  // project and issue type. These cases were the pass-through pins of the earlier rule; the owner
  // decided on 2026-11-13 that nothing is created without a template, so they are inverted here.
  it("refuses a creation when no template library is wired, before any write", async () => {
    const f = fixture(undefined);
    expect(await f.run("jira.create", CREATE)).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-missing", subject: "template library", template: "*" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("refuses a creation when the library holds no template, naming project and issue type", async () => {
    const f = fixture(SET());
    expect(await f.run("jira.create", CREATE)).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "template-missing", subject: "Story", template: "SYN/Story" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("refuses a creation when only templates of another project or issue type exist", async () => {
    const other = { ...template(ALL_POINTS), project: "OTHER" };
    const bug = { ...template(ALL_POINTS), issueType: "Bug" };
    const f = fixture(SET(other, bug));
    expect(await f.run("jira.create", { ...CREATE, fields: { summary: "x" } })).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-missing", template: "SYN/Story" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("tells a template of the type that only governs a status change from a missing one", async () => {
    const transitionOnly = template(["activateOn: [transition:Ready]"]);
    const f = fixture(SET(transitionOnly), { issue: {}, fieldCatalog: true });
    expect(await f.run("jira.create", CREATE)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-not-activated", template: "SYN/Story" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("lets a template that names edit govern the creation of its type as well", async () => {
    const f = fixture(SET(template(["activateOn: [edit]", "summaryMinLength: 40"])), {
      issue: {},
      fieldCatalog: true,
    });
    expect(await f.run("jira.create", CREATE)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "summary-too-short" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("matches the issue type by name without case and by numeric id", async () => {
    for (const issueType of ["story", "10001"]) {
      const f = fixture(
        SET({ ...template(["activateOn: [create]", "summaryMinLength: 1"]), issueType }),
        { issue: {}, fieldCatalog: true },
      );
      expect(await f.run("jira.create", CREATE)).not.toHaveProperty("violations");
      expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
    }
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

  it("names the unreadable skills to the model, not only the library", async () => {
    const f = fixture({
      templates: [],
      unreadable: 2,
      unreadableNames: ["Story template", "Bug DoR"],
    });
    expect(await f.run("jira.create", CREATE)).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [
        { ruleId: "template-unreadable", subject: "Story template, Bug DoR", template: "*" },
      ],
    });
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

describe("an edit never changes the project or the issue type of an issue (#4354, L6)", () => {
  it.each([
    ["jira.edit", "project", { key: "OTHER" }],
    ["jira.edit", "issuetype", { id: "10002" }],
    ["jira.transition", "project", { key: "OTHER" }],
    ["jira.transition", "issuetype", { id: "10002" }],
  ] as const)(
    "refuses %s carrying %s before any request, naming the way",
    async (op, id, value) => {
      const f = fixture(SET(template(ALL_POINTS)));
      const args =
        op === "jira.edit"
          ? { issueKey: "SYN-1", fields: { summary: "A longer summary", [id]: value } }
          : { issueKey: "SYN-1", transitionId: "31", fields: { [id]: value } };
      const result = await f.run(op, args);
      expect(result).toMatchObject({
        ok: false,
        reason: "field-validation",
        detail: { fieldId: id, validation: "unsupported-field" },
      });
      expect(JSON.stringify(result)).toMatch(/Move.*create the issue again/u);
      expect(f.http).not.toHaveBeenCalled();
    },
  );
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

  // #4354, owner decision 2026-11-13: an edit may not make things worse. A rule broken by a field the
  // edit touches, or newly broken, blocks it; a rule the issue already broke in an untouched field
  // does not block and is named to the person.
  it("refuses an edit that breaks a field it touches, and names only that rule", async () => {
    const f = fixture(SET(template(rules)));
    const result = await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } });
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "summary-too-short" }],
    });
    expect(JSON.stringify(result)).not.toContain("Story Points");
    expect(f.writes()).toEqual([]);
  });

  // The fixture answers a read after the write with the old issue, so the write is not confirmed;
  // these cases are about whether the gate lets the PUT go out, which is what `writes()` shows.
  it("lets an edit through when the issue already broke a rule in a field the edit does not touch", async () => {
    const f = fixture(SET(template(rules)));
    const result = await f.run("jira.edit", {
      issueKey: "SYN-1",
      fields: { summary: "A longer summary" },
    });
    expect(result).not.toHaveProperty("violations");
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
  });

  it("lets an edit through on an issue whose type has no template", async () => {
    for (const templates of [SET(), SET({ ...template(rules), issueType: "Bug" })]) {
      const f = fixture(templates);
      const result = await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } });
      expect(result).not.toHaveProperty("violations");
      expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
    }
  });

  it("governs an edit by any template of the type, whichever plain activation it names", async () => {
    for (const activation of ["create", "edit"]) {
      const f = fixture(SET(template([`activateOn: [${activation}]`, "summaryMinLength: 10"])));
      expect(
        await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } }),
      ).toMatchObject({ ok: false, violations: [{ ruleId: "summary-too-short" }] });
      expect(f.writes()).toEqual([]);
    }
  });

  it("does not let a transition-only template govern an edit", async () => {
    const f = fixture(SET(template(["activateOn: [transition:Ready]", "summaryMinLength: 10"])));
    await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "short" } });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
  });

  it("lets an edit through when the rule names a field the instance lacks and the edit does not set it", async () => {
    const f = fixture(SET(template(rules)), {
      fieldCatalog: false,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        summary: "Original summary",
        description: FULL_DESCRIPTION,
      },
    });
    await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "A longer summary" } });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1"]);
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

  it("fails closed when Jira names neither the transition nor its target status", async () => {
    const f = fixture(SET(gated), {
      fieldCatalog: true,
      unnamedTransitions: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        status: { id: "1", name: "To Do" },
        customfield_10016: 8,
      },
    });
    // The issue conforms, so only the undecidable activation can refuse it.
    expect(await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "41" })).toEqual({
      ok: false,
      reason: "field-validation",
      violations: [
        { ruleId: "template-unreadable", subject: "transition name", template: "SYN/Story" },
      ],
    });
    expect(f.writes()).toEqual([]);
  });

  it("still decides by transition id when the names are missing", async () => {
    const byId = template(["activateOn: [transition:31]", "requiredFields: [Story Points]"], "# T");
    const f = fixture(SET(byId), {
      fieldCatalog: true,
      unnamedTransitions: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        status: { id: "1", name: "To Do" },
      },
    });
    expect(await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "31" })).toMatchObject(
      { violations: [{ ruleId: "field-missing" }] },
    );
  });

  it("does not fail closed for a template of another project or issue type", async () => {
    const other = { ...gated, project: "OTHER" };
    const f = fixture(SET(other), {
      fieldCatalog: true,
      unnamedTransitions: true,
      issue: {
        project: { key: "SYN" },
        issuetype: { id: "10001", name: "Story" },
        status: { id: "1", name: "To Do" },
      },
    });
    await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "41" });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue/SYN-1/transitions"]);
  });

  it("does not activate for a transition into another status", async () => {
    const f = fixture(SET(gated));
    await f.run("jira.transition", { issueKey: "SYN-1", transitionId: "41" });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue/SYN-1/transitions"]);
  });
});

describe("dry run before approval", () => {
  it("refuses a mismatched native type both before approval and before create", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    const native = f.http.getMockImplementation();
    if (native === undefined) throw new TypeError("Missing native fixture");
    f.http.mockImplementation((request) =>
      new URL(request.url).pathname.endsWith("/issuetype/10001")
        ? Promise.resolve(response({ id: "10002", name: "Bug" }))
        : native(request),
    );
    for (const operation of [f.check, f.run]) {
      expect(await operation("jira.create", CREATE)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
        violations: [{ ruleId: "template-unreadable" }],
        // #4357 AC3: a dispatch drops the violations of this reason, so the sentence stays.
        detail: {
          messages: [
            "Jira's answer about the project and issue type could not be read completely, so the project's template cannot be applied. Nothing was changed.",
          ],
        },
      });
    }
    expect(f.writes()).toEqual([]);
    f.http.mockImplementation(native);
    expect(await f.check("jira.create", CREATE)).toEqual({ ok: true });
    await f.run("jira.create", CREATE);
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });

  it.each(["jira.edit", "jira.transition"] as const)(
    "keeps %s unsent when the complete field read changes type",
    async (operation) => {
      const f = fixture(SET(template([...ALL_POINTS, "requiredFields: [Story Points]"])), {
        fieldCatalog: true,
        issue: {
          project: { key: "SYN" },
          issuetype: { id: "10001", name: "Story" },
          summary: "Native task",
          description: FULL_DESCRIPTION,
          labels: [],
          customfield_10016: 5,
          status: { id: "1", name: "To Do" },
        },
      });
      const native = f.http.getMockImplementation();
      if (native === undefined) throw new TypeError("Missing native fixture");
      f.http.mockImplementation((request) => {
        const url = new URL(request.url);
        return url.pathname.endsWith("/issue/SYN-1") &&
          url.searchParams.get("fields")?.includes("customfield_10016")
          ? Promise.resolve(
              response({
                id: "10001",
                key: "SYN-1",
                fields: {
                  project: { key: "SYN" },
                  issuetype: { id: "10002", name: "Bug" },
                  customfield_10016: 5,
                },
              }),
            )
          : native(request);
      });
      const args: CatalogJsonObject =
        operation === "jira.edit"
          ? { issueKey: "SYN-1", fields: { summary: "Corrected native work" } }
          : { issueKey: "SYN-1", transitionId: "31" };
      expect(await f.check(operation, args)).toMatchObject({
        ok: false,
        reason: "conflict",
        violations: [{ ruleId: "template-unreadable" }],
      });
      expect(await f.run(operation, args)).toMatchObject({ ok: false, reason: "conflict" });
      expect(f.writes()).toEqual([]);
      f.http.mockImplementation(native);
      expect(await f.check(operation, args)).toEqual({ ok: true });
      await f.run(operation, args);
      expect(f.writes()).toHaveLength(1);
    },
  );

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

  it("never writes in check mode, whatever the operation", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    expect(await f.check("jira.comment", { issueKey: "SYN-1", body: "hi" })).toEqual({ ok: true });
    expect(await f.check("jira.assign", { issueKey: "SYN-1", assignee: "someone" })).toEqual({
      ok: true,
    });
    expect(f.writes()).toEqual([]);
    expect(f.paths()).toEqual([]);
  });
});

describe("operations without field state", () => {
  it("never consults templates for assign and comment", async () => {
    const f = fixture(SET(template(ALL_POINTS)));
    await f.run("jira.comment", { issueKey: "SYN-1", body: "hello" });
    expect(f.paths().some((line) => line.includes("/project/"))).toBe(false);
  });
});

describe("assignment is an edit of the assignee field (#4177, review)", () => {
  const ASSIGNED: Remote = {
    issue: {
      project: { key: "SYN" },
      issuetype: { id: "10001", name: "Story" },
      status: { id: "1", name: "To Do" },
      summary: "Original summary",
      description: FULL_DESCRIPTION,
      labels: [],
      issuelinks: [],
      assignee: { name: "bob" },
    },
    fieldCatalog: true,
  };
  const REQUIRES_ASSIGNEE = SET(template(["activateOn: [edit]", "requiredFields: [assignee]"]));

  it("refuses clearing a required assignee through jira.assign exactly as jira.edit does", async () => {
    const f = fixture(REQUIRES_ASSIGNEE, ASSIGNED);
    const violation = [{ ruleId: "field-missing", subject: "assignee", template: "SYN/Story" }];
    const edit = await f.run("jira.edit", { issueKey: "SYN-1", fields: { assignee: null } });
    expect(edit).toMatchObject({ ok: false, reason: "field-validation", violations: violation });
    const assign = await f.run("jira.assign", { issueKey: "SYN-1", clearAssignee: true });
    expect(assign).toMatchObject({ ok: false, reason: "field-validation", violations: violation });
    expect(f.writes()).toEqual([]);
  });

  it("lets a reassignment through and writes it once", async () => {
    const f = fixture(REQUIRES_ASSIGNEE, ASSIGNED);
    await f.run("jira.assign", { issueKey: "SYN-1", assigneeName: "alice" });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1/assignee"]);
  });

  it("dry-runs an assignment before approval without writing", async () => {
    const f = fixture(REQUIRES_ASSIGNEE, ASSIGNED);
    const refused = await f.check("jira.assign", { issueKey: "SYN-1", clearAssignee: true });
    expect(refused).toMatchObject({ ok: false, violations: [{ ruleId: "field-missing" }] });
    expect(await f.check("jira.assign", { issueKey: "SYN-1", assigneeName: "alice" })).toEqual({
      ok: true,
    });
    expect(f.writes()).toEqual([]);
  });

  it("changes nothing without a governing template", async () => {
    const f = fixture(SET(template(["activateOn: [create]"])), ASSIGNED);
    await f.run("jira.assign", { issueKey: "SYN-1", clearAssignee: true });
    expect(f.writes()).toEqual(["PUT /context/rest/api/2/issue/SYN-1/assignee"]);
  });
});

describe("a brace-count summary pattern is enforced as written (#4177, review)", () => {
  const PATTERN = SET(template(["activateOn: [create]", "summaryPattern: ^REQ-[0-9]{1,1000}$"]));

  it("admits the conforming summary and refuses the one that only mimics the braces", async () => {
    const f = fixture(PATTERN);
    await f.run("jira.create", { ...CREATE, fields: { ...CREATE.fields, summary: "REQ-123" } });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
    const refused = await fixture(PATTERN).run("jira.create", {
      ...CREATE,
      fields: { ...CREATE.fields, summary: "REQ-1{1,1000}" },
    });
    expect(refused).toMatchObject({
      ok: false,
      violations: [{ ruleId: "summary-pattern" }],
    });
  });

  it("does not accept a template whose count is beyond the supported bound", () => {
    const parsed = parseJiraIssueTemplate(
      [
        "---",
        "keiko: jira-issue-template",
        "version: 1",
        "project: SYN",
        "issueType: Story",
        "activateOn: [create]",
        "summaryPattern: ^REQ-[0-9]{1,100000}$",
        "---",
        SECTIONS,
      ].join("\n"),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("a required link rides on the primary write (#4177, review)", () => {
  const BLOCKS = SET(template(["activateOn: [create]", "parentLink: Blocks"]));
  const links = (...types: string[]): CatalogJsonObject[] =>
    types.map((type, index) => ({
      type,
      direction: "outward",
      issueKey: `SYN-${String(index + 2)}`,
    }));
  const createBody = (f: ReturnType<typeof fixture>): { update: { issuelinks: unknown[] } } => {
    const call = f.http.mock.calls.find(([request]) => request.url.endsWith("/rest/api/2/issue"));
    return JSON.parse(call?.[0].bodyJson ?? "null") as { update: { issuelinks: unknown[] } };
  };

  it("sends the mandatory relation inline even when an optional link is listed first", async () => {
    const f = fixture(BLOCKS);
    await f.run("jira.create", { ...CREATE, links: links("Relates", "Blocks") });
    expect(createBody(f).update.issuelinks).toEqual([
      { add: { type: { name: "Blocks" }, outwardIssue: { key: "SYN-3" } } },
    ]);
    expect(f.writes()).toEqual([
      "POST /context/rest/api/2/issue",
      "POST /context/rest/api/2/issueLink",
    ]);
  });

  it("sends the mandatory relation inline on an edit as well", async () => {
    const f = fixture(SET(template(["activateOn: [edit]", "parentLink: Blocks"])));
    await f.run("jira.edit", { issueKey: "SYN-1", links: links("Relates", "Blocks") });
    const put = f.http.mock.calls.find(([request]) => request.method === "PUT");
    const body = JSON.parse(put?.[0].bodyJson ?? "null") as { update: { issuelinks: unknown[] } };
    expect(body.update.issuelinks).toEqual([
      { add: { type: { name: "Blocks" }, outwardIssue: { key: "SYN-3" } } },
    ]);
  });

  it("refuses before any write when only a later link would satisfy the rule", async () => {
    const f = fixture(BLOCKS);
    const refused = await f.run("jira.create", { ...CREATE, links: links("Relates") });
    expect(refused).toMatchObject({
      ok: false,
      violations: [{ ruleId: "parent-missing", subject: "Blocks" }],
    });
    expect(f.writes()).toEqual([]);
  });

  it("refuses two different required relations, which one request cannot both carry", async () => {
    const f = fixture(
      SET(
        template(["activateOn: [create]", "parentLink: Blocks"]),
        template(["activateOn: [create]", "parentLink: Relates"]),
      ),
    );
    const refused = await f.run("jira.create", { ...CREATE, links: links("Blocks", "Relates") });
    expect(refused).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.writes()).toEqual([]);
  });
});

describe("a Data Center Epic create against a stored formal rule", () => {
  const EPIC_NAME = "customfield_10011";
  const EPIC_FIELDS = [
    field("project", "project", true),
    field("issuetype", "issuetype", true),
    named("summary", "string", "Summary", true),
    {
      ...named("description", "string", "Description"),
      schema: { type: "string", system: "description" },
    },
    {
      ...named(EPIC_NAME, "string", "Epic Name", true),
      schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
    },
  ];
  const remote: Remote = {
    issue: {},
    fieldCatalog: true,
    createFields: EPIC_FIELDS,
    issueTypeName: "Epic",
  };
  const epicRule = (): JiraIssueTemplateSet =>
    SET(template([...ALL_POINTS, "summaryMinLength: 20"], SECTIONS, "Epic"));
  const epic = (fields: Record<string, unknown>): CatalogJsonObject => ({
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Too short", description: FULL_DESCRIPTION, ...fields },
  });
  it("reports the formal rule, not a field error, when the Epic Name is sent by id", async () => {
    const f = fixture(epicRule(), remote);
    expect(await f.run("jira.create", epic({ [EPIC_NAME]: "REQ-1" }))).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: expect.any(String) as string, template: "SYN/Epic" }],
    });
    expect(f.writes()).toEqual([]);
  });
  it("creates the Epic once the rule holds, sending the Epic Name by id", async () => {
    const f = fixture(epicRule(), remote);
    const args = epic({ [EPIC_NAME]: "REQ-1" });
    await f.run("jira.create", {
      ...args,
      fields: { ...(args.fields as object), summary: "A sufficiently long Epic summary" },
    });
    expect(f.writes()).toEqual(["POST /context/rest/api/2/issue"]);
  });
  it("names the missing Epic Name field and the formal rule the rest breaks in one refusal", async () => {
    const f = fixture(epicRule(), remote);
    const result = await f.run("jira.create", epic({}));
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: EPIC_NAME, validation: "required-field" },
      violations: [{ ruleId: expect.any(String) as string, template: "SYN/Epic" }],
    });
    expect(f.writes()).toEqual([]);
  });
  it("names only the missing Epic Name when the supplied fields satisfy every rule", async () => {
    const f = fixture(epicRule(), remote);
    const result = await f.run(
      "jira.create",
      epic({ summary: "A sufficiently long Epic summary" }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: EPIC_NAME, validation: "required-field" },
    });
    expect(result).not.toHaveProperty("violations");
    expect(f.writes()).toEqual([]);
  });
  it("still refuses a missing Epic Name without templates, naming only the field", async () => {
    const f = fixture(undefined, remote);
    const result = await f.run("jira.create", epic({}));
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: EPIC_NAME, validation: "required-field" },
    });
    expect(result).not.toHaveProperty("violations");
    expect(f.writes()).toEqual([]);
  });
  it("tells the model which field id carries a display name it sent instead", async () => {
    const f = fixture(epicRule(), remote);
    const result = await f.run("jira.create", epic({ "Epic Name": "REQ-1" }));
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [expect.stringContaining(EPIC_NAME) as string],
      },
    });
    expect(f.writes()).toEqual([]);
  });
});
