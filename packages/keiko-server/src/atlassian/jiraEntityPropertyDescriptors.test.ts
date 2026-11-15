import { expect, it, vi } from "vitest";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { GatewayToolCatalogError } from "@oscharko-dev/keiko-model-gateway";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_ENTITY_PROPERTY_READ_DEFINITIONS,
  JIRA_PROPERTY_ENTITIES,
  jiraEntityPropertyDeclarationForTool,
} from "./jiraEntityPropertyDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

const ENTITIES = [
  ["board", { boardId: "7" }, { boardId: "7" }],
  ["sprint", { sprintId: "8" }, { sprintId: "8" }],
  [
    "comment",
    { issueIdOrKey: "SYN-1", commentId: "9" },
    { issueId: "10001", issueKey: "SYN-1", commentId: "9" },
  ],
  [
    "dashboard-item",
    { dashboardId: "10", itemId: "11" },
    { dashboardId: "10", selectedItemId: "11" },
  ],
  ["issue", { issueIdOrKey: "SYN-1" }, { issueId: "10001", issueKey: "SYN-1" }],
  ["issue-type", { issueTypeId: "12" }, { issueTypeId: "12" }],
  ["project", { projectIdOrKey: "SYN" }, { projectId: "10000", projectKey: "SYN" }],
  ["user", { username: "synthetic" }, { username: "synthetic", userKey: "actor-1" }],
] as const;
it("admits all sixteen entity-property definitions through the unchanged bounded compiler", () => {
  expect(Object.keys(JIRA_ENTITY_PROPERTY_READ_DEFINITIONS)).toHaveLength(16);
  for (const name of JIRA_READ_TOOL_FAMILIES.entityProperties) {
    const definition = JIRA_ENTITY_PROPERTY_READ_DEFINITIONS[name];
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraEntityPropertyDeclarationForTool(name)?.name).toBe(name);
    const connection = vi.fn();
    expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
    expect(connection).not.toHaveBeenCalled();
  }
});
it.each(ENTITIES)(
  "keeps %s observed key metadata separate from path selection",
  (entity, args, context) => {
    const declaration = jiraEntityPropertyDeclarationForTool(`jira.${entity}-property-keys`);
    if (declaration === undefined) throw new TypeError("Missing property declaration");
    expect(declaration.risk).toBe("read");
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, { ...args, maxResults: 2 }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        entityType: entity,
        ...context,
        items: [{ key: "ordinary" }, { key: "remote/slash%key" }],
        startAt: 0,
        total: 2,
      }),
    ).toBeUndefined();
  },
);
it.each(ENTITIES)(
  "declares %s complete typed values without raw JSON or pagination",
  (entity, args, context) => {
    const declaration = jiraEntityPropertyDeclarationForTool(`jira.${entity}-property`);
    if (declaration === undefined) throw new TypeError("Missing property declaration");
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
        ...args,
        propertyKey: "display ~key",
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        entityType: entity,
        ...context,
        propertyKey: "display ~key",
        nodeCount: 7,
        items: [
          { path: "", kind: "object", childCount: 6 },
          { path: "/a~1b", kind: "null" },
          { path: "/~0key", kind: "string", textValue: "" },
          { path: "/zero", kind: "number", numberValue: 0 },
          { path: "/false", kind: "boolean", booleanValue: false },
          { path: "/list", kind: "array", childCount: 0 },
          { path: "/map", kind: "object", childCount: 0 },
        ],
      }),
    ).toBeUndefined();
  },
);
it.each([
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "." }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: ".." }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "a/b" }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "a\\b" }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "%252f" }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "a\nb" }],
  ["jira.issue-property", { issueIdOrKey: "SYN-1", propertyKey: "key", startAt: 0 }],
  ["jira.issue-property-keys", { issueIdOrKey: "SYN-1", propertyKey: "key" }],
  ["jira.comment-property", { commentId: "9", propertyKey: "key" }],
  ["jira.dashboard-item-property", { dashboardId: "10", propertyKey: "key" }],
  ["jira.user-property", { propertyKey: "key" }],
  ["jira.user-property", { username: "synthetic", userKey: "actor-1", propertyKey: "key" }],
  ["jira.user-property-keys", { username: null }],
  ["jira.board-property", { boardId: "7", propertyKey: "key", value: 1 }],
] as const)("refuses ambiguous or unreviewed %s inputs", (name, args) => {
  const declaration = jiraEntityPropertyDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing property declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  { path: "", kind: "string" },
  { path: "", kind: "boolean", booleanValue: "false" },
  { path: "", kind: "null", textValue: "null" },
  { path: "", kind: "number", numberValue: Number.MAX_SAFE_INTEGER + 1 },
  { path: "", kind: "array", childCount: 1001 },
  { path: "", kind: "object", childCount: 129 },
  { path: "", kind: "object", childCount: 0, value: {} },
])("refuses malformed property node %j", (item) => {
  const declaration = jiraEntityPropertyDeclarationForTool("jira.issue-property");
  if (declaration === undefined) throw new TypeError("Missing property declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      entityType: "issue",
      issueId: "10001",
      issueKey: "SYN-1",
      propertyKey: "key",
      items: [item],
      nodeCount: 1,
    }),
  ).toBeDefined();
});
it("keeps dashboard selected item context explicit and refuses invented observed item identity", () => {
  const declaration = jiraEntityPropertyDeclarationForTool("jira.dashboard-item-property");
  if (declaration === undefined) throw new TypeError("Missing property declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      entityType: "dashboard-item",
      dashboardId: "10",
      itemId: "11",
      propertyKey: "key",
      items: [{ path: "", kind: "null" }],
      nodeCount: 1,
    }),
  ).toBeDefined();
});
it.each([
  ["board", "/rest/agile/1.0", "/board/{boardId}/properties"],
  ["sprint", "/rest/agile/1.0", "/sprint/{sprintId}/properties"],
  ["comment", "/rest/api/2", "/comment/{commentId}/properties"],
  ["dashboard-item", "/rest/api/2", "/dashboard/{dashboardId}/items/{itemId}/properties"],
  ["issue", "/rest/api/2", "/issue/{issueIdOrKey}/properties"],
  ["issue-type", "/rest/api/2", "/issuetype/{issueTypeId}/properties"],
  ["project", "/rest/api/2", "/project/{projectIdOrKey}/properties"],
  ["user", "/rest/api/2", "/user/properties"],
] as const)(
  "binds both %s property reads to fixed native GET identities",
  (entity, apiRoot, path) => {
    for (const [suffix, pathTemplate] of [
      ["property-keys", path],
      ["property", `${path}/{propertyKey}`],
    ]) {
      expect(jiraOperationForTool(`jira.${entity}-${String(suffix)}`)?.definition).toMatchObject({
        kind: "native",
        method: "GET",
        apiRoot,
        pathTemplate,
        effects: ["remote-read"],
      });
    }
  },
);

// #4357 AC4. The read `jira.issue-property-keys` was refused in the selection run of 2026-11-12 with
// `catalogReason=invalid-shape`, `missingRequired=["issueIdOrKey"]`, no unexpected property and no
// invalid path: the model sent no issue identity. That refusal is the schema working as designed (the
// same tool completed 82 times in the lab logs), so the class pin below holds the invariant that
// makes it correct and actionable for every entity-property tool: empty arguments are refused naming
// exactly the identity the entity requires, the correction the model receives names it, and the
// offered schema keeps `required`. Expected names derive from the entity table the descriptors are
// built from, never from a restated list.
const PROPERTY_TOOLS = (
  Object.keys(JIRA_PROPERTY_ENTITIES) as (keyof typeof JIRA_PROPERTY_ENTITIES)[]
).flatMap((kind) => [
  { name: `jira.${kind}-property-keys`, kind, single: false },
  { name: `jira.${kind}-property`, kind, single: true },
]);
function emptyArgumentMismatch(name: string): {
  readonly shape: NonNullable<ReturnType<typeof describeCatalogSchemaMismatch>>;
  readonly inputSchema: Record<string, unknown>;
} {
  const declaration = jiraEntityPropertyDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing property declaration");
  const shape = describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {});
  if (shape === undefined) throw new TypeError(`${name} accepted empty arguments`);
  return { shape, inputSchema: declaration.descriptor.inputSchema };
}
it.each(PROPERTY_TOOLS)(
  "refuses empty arguments of $name naming exactly the required identity",
  ({ name, kind, single }) => {
    const entity = JIRA_PROPERTY_ENTITIES[kind];
    const { shape, inputSchema } = emptyArgumentMismatch(name);
    const required = [...entity.required, ...(single ? ["propertyKey"] : [])].sort();
    if ("userSelector" in entity) {
      // The exactly-one choice owns username and userKey; what is named beyond it is the rest.
      expect(shape.choice).toEqual({
        kind: "exactly-one",
        alternatives: [["username"], ["userKey"]],
      });
      const choiceNames = new Set(shape.choice?.alternatives.flat());
      const beyondChoice = shape.missingRequired.filter((path) => !choiceNames.has(path));
      expect([...beyondChoice].sort()).toEqual(required);
    } else {
      expect([...shape.missingRequired].sort()).toEqual(required);
      expect(shape.choice).toBeUndefined();
      // No root alternative: the provider projection passes this schema through unchanged, so the
      // model is offered exactly these required names.
      expect(inputSchema.oneOf).toBeUndefined();
      expect([...(inputSchema.required as string[])].sort()).toEqual(required);
    }
    expect(shape.invalidPaths).toEqual([]);
    expect(shape.unexpectedPropertyCount).toBe(0);
  },
);
it.each(PROPERTY_TOOLS)(
  "tells the model what to supply when $name arguments are empty",
  ({ name }) => {
    const { shape } = emptyArgumentMismatch(name);
    const correction = new GatewayToolCatalogError("invalid-arguments", undefined, true, {
      toolCallId: "call-1",
      offeredAlias: name.replaceAll(/[.-]/gu, "_"),
      shape,
    }).correction();
    if (correction === undefined) throw new TypeError("Missing schema correction");
    const choiceNames = new Set(shape.choice?.alternatives.flat());
    if (shape.missingRequired.some((path) => !choiceNames.has(path)))
      expect(correction).toContain(
        `Missing required properties: ${shape.missingRequired.join(", ")}.`,
      );
    if (shape.choice !== undefined)
      expect(correction).toContain("Supply exactly one of: username, userKey; omit the others.");
    expect(correction).not.toContain("invalid-shape");
  },
);
