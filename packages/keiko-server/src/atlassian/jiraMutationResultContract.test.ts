import { describe, expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_LINKS_MAX,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_RESULT_STATES,
  JIRA_RESULT_GUIDANCE_MAX_CHARS,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  jiraOperationInReleaseScope,
  parseJiraIssueTemplate,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
  type JiraMutationLinkAccount,
  type JiraMutationResultState,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  createJiraDraftStore,
  executeJiraDraftStageTool,
  jiraTemplateGuidanceVariants,
  jiraTemplateViolationGuidance,
  type AtlassianHttpBodyPort,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { field, response } from "../../../../tests/support/jira-managed-remote.js";
import { jiraDeclarationForTool, jiraOperationBindingForTool } from "./jiraManagedProvider.js";
import { jiraAttemptToolResult, jiraMutationToolResult } from "./jiraMutationResult.js";

// #4354 (live Gemma composer run, 2026-11-14): a Sub-task asked under a Story was refused by the
// template's parent rule, and the refusal's guidance (549 characters) did not fit the 512 the result
// schema of jira.create allowed, so the catalog rejected the provider's result (`result-contract-
// failed`, data null) and the model never learned why. A refusal must always settle as a valid,
// explained result. These tests hold that for every result schema that carries guidance and for every
// shape the producers can build, and they go through what the model receives: the result with the
// operation binding the provider adds, checked by the catalog's own schema validation and byte bound.

/** The tools whose results carry template guidance: the write tools, the draft run and its stages. */
const CARRIERS = [
  ...JIRA_MUTATION_OPERATIONS.filter((operation) => jiraOperationInReleaseScope(operation)),
  "jira.draft-stage",
  "jira.draft-batch",
] as const;
/** The tools whose results the mutation producers build (the draft producers have their own proof). */
const WRITE_TOOLS = JIRA_MUTATION_OPERATIONS.filter(
  (operation) =>
    jiraOperationInReleaseScope(operation) &&
    operation !== "jira.draft" &&
    operation !== "jira.create-issues",
);
type ResultData = ReturnType<typeof jiraMutationToolResult>["data"];

function descriptorOf(tool: string): NonNullable<ReturnType<typeof jiraDeclarationForTool>> {
  const declaration = jiraDeclarationForTool(tool);
  if (declaration === undefined) throw new TypeError(`${tool} declares no descriptor`);
  return declaration;
}
/** What the model receives: the producer's data with the operation binding the provider adds. */
function received(tool: string, data: ResultData): ResultData {
  return { ...data, operationBinding: jiraOperationBindingForTool(tool) ?? null };
}
/** The catalog's own checks of a provider result: its schema, and its byte bound. */
function catalogProblem(tool: string, data: ResultData): string | undefined {
  const descriptor = descriptorOf(tool).descriptor;
  const model = received(tool, data);
  const mismatch = describeCatalogSchemaMismatch(descriptor.resultSchema, model);
  if (mismatch !== undefined) return JSON.stringify(mismatch);
  const bytes = Buffer.byteLength(JSON.stringify(model));
  return bytes > descriptor.bounds.maxResultBytes
    ? `${String(bytes)} bytes exceed ${String(descriptor.bounds.maxResultBytes)}`
    : undefined;
}
function guidanceBound(tool: string): number | undefined {
  const schema = descriptorOf(tool).descriptor.resultSchema as {
    readonly properties?: { readonly guidance?: { readonly maxLength?: number } };
  };
  return schema.properties?.guidance?.maxLength;
}

describe("the template guidance fits every result schema that carries it", () => {
  const variants = jiraTemplateGuidanceVariants();
  const longest = Math.max(...variants.map((variant) => variant.length));

  it("enumerates every combination the producer can emit", () => {
    expect(new Set(variants).size).toBe(variants.length);
    // Whatever the gate can name, alone or all at once, the guidance it gets is among the variants.
    for (const ruleId of JIRA_TEMPLATE_RULE_IDS) {
      const guidance = jiraTemplateViolationGuidance([violation(ruleId)]);
      expect(variants, ruleId).toContain(guidance);
    }
    expect(variants).toContain(
      jiraTemplateViolationGuidance(JIRA_TEMPLATE_RULE_IDS.map(violation)),
    );
    // The refusal that carries a parent rule and a section rule at once is the longest ordinary one.
    expect(longest).toBeGreaterThan(1000);
  });

  it("holds the longest variant within the shared bound, and the bound within a stated margin of it", () => {
    expect(longest).toBeLessThanOrEqual(JIRA_RESULT_GUIDANCE_MAX_CHARS);
    // The bound follows the producer; it is not a number picked far above what is written.
    expect(JIRA_RESULT_GUIDANCE_MAX_CHARS).toBeLessThanOrEqual(longest + 256);
  });

  it.each(CARRIERS)("%s: every variant fits its own result schema, uncut", (tool) => {
    const bound = guidanceBound(tool);
    if (bound === undefined) throw new TypeError(`${tool} declares no guidance in its result`);
    for (const variant of variants)
      expect(variant.length, `${tool}: ${variant.slice(0, 48)}…`).toBeLessThanOrEqual(bound);
  });
});

const violation = (ruleId: JiraTemplateViolation["ruleId"]): JiraTemplateViolation => ({
  ruleId,
  subject: "x".repeat(120),
  template: "SYN/Task",
});
const ALL_VIOLATIONS = Array.from({ length: JIRA_TEMPLATE_VIOLATIONS_MAX }, (_, index) =>
  violation(JIRA_TEMPLATE_RULE_IDS[index % JIRA_TEMPLATE_RULE_IDS.length] ?? "summary-too-short"),
);
/** A refusal names a field only where an issue field was judged; no other tool's `fieldId` is one. */
const MAX_DETAIL = (
  validation: (typeof JIRA_FIELD_VALIDATION_FAILURES)[number],
  naming: boolean,
): JiraMutationFailureDetail => ({
  unchanged: true,
  ...(naming ? { fieldId: "f".repeat(64) } : {}),
  validation,
  fieldErrors: Array.from({ length: JIRA_MUTATION_DETAIL_LIMITS.fieldErrors }, () => ({
    fieldId: "f".repeat(64),
    fieldName: "n".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
    message: "m".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
  })),
  messages: Array.from({ length: JIRA_MUTATION_DETAIL_LIMITS.messages }, () =>
    "m".repeat(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
  ),
});
const MAX_LINKS: JiraMutationLinkAccount = {
  requested: JIRA_MUTATION_LINKS_MAX,
  created: 0,
  missing: Array.from({ length: JIRA_MUTATION_LINKS_MAX }, () => ({
    type: "t".repeat(255),
    direction: "outward" as const,
    issueKey: "K".repeat(128),
  })),
  unconfirmed: true,
};

/**
 * What a producer can attach to a result: the template gate checks a create, an edit, a transition
 * and an assignment, so only their refusals carry violations, and only a create or an edit lists
 * requested links. The catalog bounds each tool by what it can reach, so a shape is walked through
 * exactly the tools that can produce it.
 */
type Reach = "any" | "gated" | "linked";
const GATED_TOOLS: readonly string[] = [
  "jira.create",
  "jira.edit",
  "jira.transition",
  "jira.assign",
];
const SHAPE_BEARERS: Readonly<Record<Reach, (tool: string) => boolean>> = {
  any: () => true,
  gated: (tool) => GATED_TOOLS.includes(tool),
  linked: (tool) => tool === "jira.create" || tool === "jira.edit",
};
const REACHES = [
  ["any", undefined, undefined, false],
  ["gated", undefined, ALL_VIOLATIONS, true],
  ["linked", MAX_LINKS, ALL_VIOLATIONS, true],
] as const;
type Shape = readonly [reach: Reach, name: string, data: ResultData];

function failureShapes(
  state: Exclude<JiraMutationResultState, "pending" | "succeeded">,
  reason: (typeof ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS)[number],
): readonly Shape[] {
  const shapes: Shape[] = [];
  for (const [reach, links, violations, naming] of REACHES) {
    for (const validation of JIRA_FIELD_VALIDATION_FAILURES) {
      const failed: JiraMutationAttempt = {
        ok: false,
        reason,
        detail: MAX_DETAIL(validation, naming),
        ...(links === undefined ? {} : { links }),
        ...(violations === undefined ? {} : { violations }),
      };
      shapes.push([
        reach,
        `${state}/${reason}/${validation}/${reach}`,
        jiraAttemptToolResult(state, failed).data,
      ]);
    }
  }
  return shapes;
}

/** Every worst-case result the producers build, by their own closed vocabularies. */
function producedShapes(): readonly Shape[] {
  const shapes: Shape[] = [];
  for (const state of JIRA_MUTATION_RESULT_STATES) {
    // A refusal is never `succeeded`, and `pending` is only the producer's direct input.
    if (state !== "succeeded") {
      for (const reason of ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS) {
        for (const [reach, links, violations, naming] of REACHES)
          shapes.push([
            reach,
            `${state}/${reason}/replayed/${reach}`,
            jiraMutationToolResult(
              state,
              reason,
              {},
              true,
              MAX_DETAIL("invalid-field", naming),
              links,
              violations,
            ).data,
          ]);
        if (state !== "pending") shapes.push(...failureShapes(state, reason));
      }
    }
    if (state === "pending") continue;
    const succeeded: JiraMutationAttempt = {
      ok: true,
      receipt: {},
      links: MAX_LINKS,
      templateNotices: ALL_VIOLATIONS,
    };
    if (state === "succeeded")
      shapes.push([
        "linked",
        `${state}/succeeded with notices`,
        jiraAttemptToolResult(state, succeeded).data,
      ]);
  }
  // The refusals of the template gate, one per kind of guidance the producer writes: what the model
  // receives for a Sub-task under a Story and for every other rule the gate can name.
  for (const variantViolations of [
    ...JIRA_TEMPLATE_RULE_IDS.map((ruleId) => [violation(ruleId)]),
    JIRA_TEMPLATE_RULE_IDS.map(violation),
  ])
    shapes.push([
      "gated",
      `template refusal of ${variantViolations.map((item) => item.ruleId).join("+")}`,
      jiraMutationToolResult(
        "rejected",
        "field-validation",
        {},
        false,
        undefined,
        undefined,
        variantViolations,
      ).data,
    ]);
  return shapes;
}

describe("every shape the write producers build is a valid result of every write tool", () => {
  const shapes = producedShapes();

  it("walks a real set of shapes", () => {
    expect(shapes.length).toBeGreaterThan(500);
    expect(WRITE_TOOLS.length).toBeGreaterThan(100);
    // Each kind of shape reaches at least one tool: nothing is walked through no one.
    for (const reach of ["any", "gated", "linked"] as const)
      expect(WRITE_TOOLS.filter(SHAPE_BEARERS[reach]).length, reach).toBeGreaterThan(0);
    // Every tool the gate checks declares the violations it can carry.
    for (const tool of GATED_TOOLS)
      expect(
        Object.keys(descriptorOf(tool).descriptor.resultSchema.properties ?? {}),
        tool,
      ).toContain("violations");
  });

  it.each(WRITE_TOOLS)("%s accepts all of them, as the model receives them", (operation) => {
    const refused = shapes
      .filter(([reach]) => SHAPE_BEARERS[reach](operation))
      .map(([, name, data]) => [name, catalogProblem(operation, data)] as const)
      .filter(([, problem]) => problem !== undefined)
      .slice(0, 3);
    expect(refused).toEqual([]);
  });
});

// The draft run's stages build their own results: the stage tool refuses an item by a template rule
// with the same guidance, in a result with its own schema and bound. Its real producer, run against a
// Story-parent rule, is checked the same way.
describe("the draft-stage refusal by a parent rule is a valid result as the model receives it", () => {
  const CONTEXT: ManagedMcpInvocationContext = {
    invocationId: "invocation",
    correlationId: "correlation",
    signal: new AbortController().signal,
    beforeEffect: () => true,
  };
  const FIELDS = [
    field("project", "project", true),
    field("issuetype", "issuetype", true),
    { ...field("summary", "string", true), name: "Summary" },
    field("parent", "issuelink"),
  ];

  function connection(template: string): JiraManagedConnection {
    const parsed = parseJiraIssueTemplate(template);
    if (!parsed.ok) throw new TypeError("Expected a parseable template");
    const http = vi.fn<AtlassianHttpBodyPort>((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/project/10000"))
        return Promise.resolve(response({ id: "10000", key: "SYN" }));
      if (path.endsWith("/issuetype/10001"))
        return Promise.resolve(response({ id: "10001", name: "Task" }));
      // The parent SYN-4 is a Task, the template wants a Story.
      if (path.endsWith("/issue/SYN-4"))
        return Promise.resolve(
          response({
            id: "20004",
            key: "SYN-4",
            fields: { issuetype: { id: "10001", name: "Task" } },
          }),
        );
      if (path.includes("createmeta"))
        return Promise.resolve(
          response({ values: FIELDS, start: 0, size: 100, last: true, total: FIELDS.length }),
        );
      return Promise.resolve(response({}, 404));
    });
    return {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      identity: "credential-1",
      http,
      issueTemplates: () => ({ templates: [parsed.template], unreadable: 0 }),
    };
  }
  // The template's body names the section the description must have.
  const TEMPLATE = [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    "project: SYN",
    "issueType: Task",
    "activateOn: [create]",
    'parentField: "parent"',
    "parentIssueTypes: [Story]",
    "---",
    "## Acceptance criteria\n",
  ].join("\n");

  it.each([
    ["the parent rule", "h2. Acceptance criteria\n* works"],
    ["the parent rule together with a missing section", "No such section here."],
  ])("settles the refusal by %s as a valid result", async (_name, description) => {
    const refused = await executeJiraDraftStageTool(
      {
        items: [
          {
            ref: "sub",
            projectId: "10000",
            issueTypeId: "10001",
            fields: { summary: "Sub", description },
            parent: { fieldId: "parent", issueKey: "SYN-4" },
          },
        ],
      },
      CONTEXT,
      connection(TEMPLATE),
      {
        store: createJiraDraftStore({}),
        owner: () => "chat-1",
        activity: () => undefined,
      },
    );
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ outcome: "rejected", reason: "field-validation" });
    expect(catalogProblem("jira.draft-stage", refused.data)).toBeUndefined();
  });
});
