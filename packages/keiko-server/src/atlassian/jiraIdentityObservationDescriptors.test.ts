import { expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_IDENTITY_OBSERVATION_READ_DEFINITIONS,
  jiraIdentityObservationDeclarationForTool,
} from "./jiraIdentityObservationDescriptors.js";

it("uses the unchanged compiler and read-effect declaration for four fixed observations", () => {
  expect(Object.keys(JIRA_IDENTITY_OBSERVATION_READ_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_IDENTITY_OBSERVATION_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    const declaration = jiraIdentityObservationDeclarationForTool(name);
    expect(declaration?.name).toBe(name);
    expect(declaration?.risk).toBe("read");
  }
  expect(jiraIdentityObservationDeclarationForTool("jira.anonymize-user")).toBeUndefined();
});
it.each([
  [
    "jira.anonymization-validation",
    { userKey: "U1" },
    {
      observationScope: "validation",
      userKey: "U1",
      validation: {
        success: false,
        deleted: false,
        businessLogicValidationFailed: true,
        operations: [],
        errors: [],
      },
    },
  ],
  [
    "jira.anonymization-rerun-validation",
    { userKey: "U1", oldUserKey: "before", oldUserName: "Old Name" },
    {
      observationScope: "rerun-validation",
      userKey: "U1",
      validation: {
        warnings: [{ operation: "plugin:handler", messages: ["Native warning"], fields: [] }],
      },
    },
  ],
  [
    "jira.anonymization-progress",
    { taskId: "9223372036854775807" },
    {
      observationScope: "anonymization-progress",
      taskSelection: "selected-task",
      selectedTaskId: "9223372036854775807",
      progress: {
        userKey: "U1",
        status: "COMPLETED",
        currentProgress: 0,
        currentSubTask: "",
        isRerun: false,
        errors: [{ operation: "GENERAL", messages: ["Failed handler"] }],
      },
    },
  ],
  [
    "jira.anonymization-progress",
    {},
    {
      observationScope: "anonymization-progress",
      taskSelection: "active-or-latest",
      progress: { userKey: "U1", status: "FUTURE_STATE" },
    },
  ],
  [
    "jira.current-session",
    {},
    {
      observationScope: "bound-current-user-session",
      userKey: "U1",
      username: "Canonical-Name",
      loginInfo: { loginCount: 0, previousLoginTime: "2026-11-08T10:00:00.000+0000" },
    },
  ],
] as const)(
  "declares typed %s observations without inventing successful identity mutation",
  (name, args, result) => {
    const declaration = jiraIdentityObservationDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing identity-observation declaration");
    expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        outcome: "succeeded",
        ...result,
      }),
    ).toBeUndefined();
  },
);
it.each([
  ["jira.anonymization-validation", {}],
  ["jira.anonymization-validation", { userKey: "U1", newOwnerKey: "admin" }],
  ["jira.anonymization-validation", { userKey: "U1", expand: "affectedEntities" }],
  ["jira.anonymization-rerun-validation", { userKey: "U1", oldUserKey: null }],
  ["jira.anonymization-progress", { taskId: "0" }],
  ["jira.anonymization-progress", { taskId: 7 }],
  ["jira.current-session", { username: "other" }],
  ["jira.current-session", { password: "not-sent" }],
  ["jira.current-session", { method: "DELETE" }],
] as const)("does not admit effect, credential or unbound %s arguments", (name, args) => {
  const declaration = jiraIdentityObservationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing identity-observation declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.anonymization-validation", { validation: { success: "false" } }],
  ["jira.anonymization-validation", { validation: { affectedEntities: [] } }],
  ["jira.anonymization-progress", { progress: { userKey: "U1", currentProgress: 0.5 } }],
  ["jira.anonymization-progress", { progress: { userKey: "U1", success: true } }],
  ["jira.anonymization-progress", { progress: { userKey: "U1", executingNode: "private-node" } }],
  [
    "jira.anonymization-progress",
    { progress: { userKey: "U1", progressUrl: "https://untrusted.invalid" } },
  ],
  ["jira.current-session", { session: { name: "JSESSIONID", value: "not-projected" } }],
  ["jira.current-session", { loginInfo: { loginCount: -1 } }],
  ["jira.current-session", { loginInfo: { lastFailedLoginTime: null } }],
] as const)("refuses invented, sensitive or malformed %s facts", (name, result) => {
  const declaration = jiraIdentityObservationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing identity-observation declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});

it("keeps the task review's observed owner and null/absent states without a process proof", () => {
  const declaration = jiraIdentityObservationDeclarationForTool("jira.anonymization-progress");
  if (declaration === undefined) throw new TypeError("Missing progress declaration");
  const reviewSnapshot = {
    userKey: "target",
    executingNode: "owner-node",
    submittedTime: "native-time",
    status: "RUNNING",
    isRerun: false,
    currentProgress: 0,
    operations: [],
    startTime: null,
  };
  const result = {
    outcome: "succeeded",
    observationScope: "anonymization-progress",
    taskSelection: "active-or-latest",
    progress: { userKey: "target" },
    reviewSnapshot,
  };
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, result),
  ).toBeUndefined();
  for (const field of ["shutdownConfirmed", "taskId", "progressUrl"])
    expect(
      describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
        ...result,
        reviewSnapshot: { ...reviewSnapshot, [field]: true },
      }),
    ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      ...result,
      reviewSnapshot: { ...reviewSnapshot, executingNode: null },
    }),
  ).toBeDefined();
});
