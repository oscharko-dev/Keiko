import { afterEach, expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  JIRA_MANAGED_ACTION_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraProjectStructureDeclarationForTool } from "./jiraProjectStructureDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { recordJiraFieldRefusal, recordJiraTemplateRefusal } from "./jiraTemplateLog.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

afterEach(resetServerLogger);

const ID = "9007199254740993";
const VERSION = {
  versionId: ID,
  projectId: "10000",
  name: "Release",
  startDate: "2028-02-29",
  released: false,
};
const COMPONENT = {
  id: ID,
  name: "Engine",
  project: "SYN",
  leadUserName: "owner",
  assigneeType: "COMPONENT_LEAD",
  archived: false,
};
const CASES = [
  {
    name: "jira.components",
    args: { projectIdOrKey: "SYN", maxResults: 25 },
    result: { items: [COMPONENT], startAt: 0, total: 1 },
  },
  { name: "jira.component", args: { componentId: ID }, result: { items: [COMPONENT] } },
  {
    name: "jira.versions",
    args: { projectIdOrKey: "SYN", startAt: 0 },
    result: { items: [VERSION], startAt: 0, total: 1 },
  },
  { name: "jira.version", args: { versionId: ID }, result: VERSION },
  {
    name: "jira.create-component",
    args: {
      projectIdOrKey: "SYN",
      name: "Engine",
      description: "",
      assigneeType: "PROJECT_DEFAULT",
    },
    result: { componentId: ID, projectId: "10000", projectKey: "SYN" },
  },
  {
    name: "jira.update-component",
    args: { componentId: ID, leadUserName: "owner" },
    result: { componentId: ID, projectId: "10000", projectKey: "SYN" },
  },
  {
    name: "jira.create-version",
    args: { projectId: "10000", name: "Release", startDate: "2028-02-29" },
    result: { versionId: ID },
  },
  {
    name: "jira.update-version",
    args: { versionId: ID, released: true },
    result: { versionId: ID },
  },
] as const;

it.each(CASES)(
  "offers the actual $name contract through the existing factory",
  ({ name, args, result }) => {
    const declaration = jiraProjectStructureDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing structure declaration");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...result,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
        ...args,
        url: "https://other.invalid",
      }),
    ).toBeDefined();
    const connection = vi.fn();
    const execute = vi.fn();
    const provider = createJiraProviderForCatalog(connection, [name], execute);
    expect(provider.tools()).toHaveLength(1);
    expect(provider.tools()[0]?.descriptor.inputSchema).toEqual(declaration.descriptor.inputSchema);
    expect(connection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  },
);

it.each(["jira.create-version", "jira.update-version"] as const)(
  "preserves known project context for an uncertain %s without inventing a version identity",
  (name) => {
    const declaration = jiraProjectStructureDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing structure declaration");
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "unknown",
        reason: "unavailable",
        projectId: "10000",
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "unknown",
        projectId: "not-an-id",
      }),
    ).toBeDefined();
  },
);

it.each([
  ["jira.update-component", { componentId: ID }],
  ["jira.update-version", { versionId: ID }],
  ["jira.update-component", { componentId: ID, archived: true }],
  ["jira.update-version", { versionId: ID, projectId: "10000" }],
  ["jira.create-version", { projectId: 10000, name: "Release" }],
  ["jira.create-version", { projectId: "10000", name: "Release", startDate: "2027-02-29" }],
  [
    "jira.create-version",
    { projectId: "10000", name: "Release", releaseDate: "2028-02-29T00:00:00Z" },
  ],
  ["jira.update-version", { versionId: ID, released: "false" }],
  ["jira.create-component", { projectIdOrKey: "SYN", name: "Engine", assigneeType: "OWNER" }],
  ["jira.components", { projectIdOrKey: "../SYN" }],
  ["jira.components", { projectIdOrKey: "SYN", maxResults: 101 }],
  ["jira.versions", { projectIdOrKey: "SYN", startAt: -1 }],
] as const)("rejects unsupported %s arguments before dispatch", (name, args) => {
  const declaration = jiraProjectStructureDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing structure declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});

it.each([
  ["jira.create-component", "high"],
  ["jira.update-component", "medium"],
  ["jira.create-version", "high"],
  ["jira.update-version", "high"],
] as const)("keeps %s in shared write authority with %s risk", (name, risk) => {
  const action = JIRA_MANAGED_ACTION_TYPES[name];
  expect(ATLASSIAN_CONNECTOR_ACTION_CLASS[action]).toBe("connector-write");
  expect(ATLASSIAN_CONNECTOR_ACTION_PROVIDER[action]).toBe("jira");
  expect(ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[action]).toBe("issue-tracker.write");
  expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[action]).toBe(risk);
  expect(() => createJiraProviderForCatalog(vi.fn(), [name])).toThrow(TypeError);
});

it.each(["jira.components", "jira.version"])(
  "retains local and remote failure details for %s",
  (name) => {
    const declaration = jiraProjectStructureDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing structure declaration");
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "failed",
        reason: "invalid-input",
        fieldErrors: [{ fieldId: "name", message: "Required" }],
        messages: ["Correction required"],
      }),
    ).toBeUndefined();
  },
);

it("does not offer unregistered operations or inherited keys", () => {
  for (const name of ["jira.proxy", "jira.delete-component", "jira.merge-version", "constructor"])
    expect(jiraProjectStructureDeclarationForTool(name)).toBeUndefined();
});

it.each([
  "jira.create-project",
  "jira.update-project",
  "jira.create-component",
  "jira.update-component",
  "jira.create-version",
  "jira.update-version",
] as const)(
  "logs %s metadata validation without claiming an issue-template admission",
  (operation) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    recordJiraFieldRefusal("structure-refusal", {
      operation,
      refusedCount: 1,
      validations: ["invalid-field"],
    });
    recordJiraTemplateRefusal("structure-refusal", {
      operation,
      stage: "pre-approval",
      violations: [{ ruleId: "field-unavailable" }],
    });
    expect(
      sink.events.map(({ op, correlationId, extra }) => ({ op, correlationId, extra })),
    ).toEqual([
      {
        op: "jira.field.admission",
        correlationId: "structure-refusal",
        extra: {
          operation,
          refusedCount: 1,
          validations: ["invalid-field"],
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
  },
);
