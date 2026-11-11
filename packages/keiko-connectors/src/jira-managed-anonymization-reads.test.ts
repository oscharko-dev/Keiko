import { expect, it, vi, type Mock } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraAnonymizationRead as read,
  isJiraAnonymizationRead,
  JIRA_ANONYMIZATION_READS,
} from "./jira-managed-anonymization-reads.js";

const port = (outcome: AtlassianWriteHttpOutcome): Mock<JiraMutationRequest> =>
  vi.fn<JiraMutationRequest>().mockResolvedValue(outcome);
const success = (body: Record<string, unknown>): Mock<JiraMutationRequest> =>
  port({ ok: true, status: 200, body });
it("binds validation to the exact native user key and preserves false/empty diagnostics", async () => {
  const request = success({
    userKey: "USER + QA",
    userName: "",
    displayName: null,
    success: false,
    deleted: false,
    businessLogicValidationFailed: true,
    operations: [],
    errors: {},
    warnings: {},
    email: "unprojected@example.invalid",
    affectedEntities: { REMOVE: [{ uri: "https://untrusted.invalid" }] },
  });
  expect(
    (await read("jira.anonymization-validation", { userKey: "USER + QA" }, request)).data,
  ).toEqual({
    outcome: "succeeded",
    observationScope: "validation",
    userKey: "USER + QA",
    validation: {
      userName: "",
      success: false,
      deleted: false,
      businessLogicValidationFailed: true,
      operations: [],
      errors: [],
      warnings: [],
    },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/anonymization?userKey=USER+%2B+QA",
    "GET",
    undefined,
    "json",
  );
});
it("only validates a rerun and preserves supplied historical selectors exactly", async () => {
  const request = success({ userKey: "new-key", success: true });
  const result = await read(
    "jira.anonymization-rerun-validation",
    {
      userKey: "new-key",
      oldUserKey: "old+key",
      oldUserName: "Old & Name",
    },
    request,
  );
  expect(result.data).toEqual({
    outcome: "succeeded",
    observationScope: "rerun-validation",
    userKey: "new-key",
    validation: { success: true },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/anonymization/rerun?userKey=new-key&oldUserKey=old%2Bkey&oldUserName=Old+%26+Name",
    "GET",
    undefined,
    "json",
  );
});
it("does not invent historical keys when native rerun validation does not need them", async () => {
  const request = success({ userKey: "already-current" });
  expect(
    (await read("jira.anonymization-rerun-validation", { userKey: "already-current" }, request))
      .data.validation,
  ).toEqual({});
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/anonymization/rerun?userKey=already-current",
    "GET",
    undefined,
    "json",
  );
});
it("projects native diagnostic groups without interpreting handler names or following links", async () => {
  const request = success({
    userKey: "U1",
    errors: {
      GENERAL: {
        errorMessages: ["Review the current user."],
        errors: { target: "Not eligible" },
        status: 400,
      },
    },
    warnings: {
      "plugin:handler": { errorMessages: ["See https://example.invalid/help"], errors: {} },
    },
  });
  expect(
    (await read("jira.anonymization-validation", { userKey: "U1" }, request)).data.validation,
  ).toEqual({
    errors: [
      {
        operation: "GENERAL",
        messages: ["Review the current user."],
        fields: [{ field: "target", message: "Not eligible" }],
      },
    ],
    warnings: [
      { operation: "plugin:handler", messages: ["See https://example.invalid/help"], fields: [] },
    ],
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("keeps selected task context separate from observed progress and native failure state", async () => {
  const request = success({
    userKey: "observed-user",
    userName: "Observed",
    fullName: null,
    currentProgress: 0,
    currentSubTask: "",
    submittedTime: "2026-11-08T10:00:00.000+0000",
    startTime: null,
    finishTime: null,
    status: "COMPLETED",
    isRerun: false,
    errors: { GENERAL: { errorMessages: ["One handler failed."] } },
    operations: ["NATIVE_FUTURE_HANDLER"],
    progressUrl: "https://untrusted.invalid/run",
    executingNode: "private-node",
    success: true,
  });
  expect(
    (await read("jira.anonymization-progress", { taskId: "9223372036854775807" }, request)).data,
  ).toEqual({
    outcome: "succeeded",
    observationScope: "anonymization-progress",
    taskSelection: "selected-task",
    selectedTaskId: "9223372036854775807",
    progress: {
      userKey: "observed-user",
      userName: "Observed",
      currentProgress: 0,
      currentSubTask: "",
      submittedTime: "2026-11-08T10:00:00.000+0000",
      status: "COMPLETED",
      isRerun: false,
      errors: [{ operation: "GENERAL", messages: ["One handler failed."] }],
      operations: ["NATIVE_FUTURE_HANDLER"],
    },
    reviewSnapshot: {
      executingNode: "private-node",
      userKey: "observed-user",
      userName: "Observed",
      fullName: null,
      currentProgress: 0,
      currentSubTask: "",
      submittedTime: "2026-11-08T10:00:00.000+0000",
      startTime: null,
      finishTime: null,
      status: "COMPLETED",
      isRerun: false,
      errors: [{ operation: "GENERAL", messages: ["One handler failed."] }],
      operations: ["NATIVE_FUTURE_HANDLER"],
    },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/anonymization/progress?taskId=9223372036854775807",
    "GET",
    undefined,
    "json",
  );
});
it("observes active-or-latest once and keeps omitted progress unknown", async () => {
  const request = success({
    userKey: "U1",
    currentProgress: null,
    isRerun: null,
    operations: null,
    status: "FUTURE_STATE",
  });
  expect((await read("jira.anonymization-progress", {}, request)).data).toEqual({
    outcome: "succeeded",
    observationScope: "anonymization-progress",
    taskSelection: "active-or-latest",
    progress: { userKey: "U1", status: "FUTURE_STATE" },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/anonymization/progress",
    "GET",
    undefined,
    "json",
  );
});
it.each([
  ["jira.anonymization-validation", {}],
  ["jira.anonymization-validation", { userKey: "U1", expand: "affectedEntities" }],
  ["jira.anonymization-validation", { userKey: "U1", newOwnerKey: "admin" }],
  ["jira.anonymization-rerun-validation", { userKey: "U1", oldUserKey: null }],
  ["jira.anonymization-rerun-validation", { userKey: "U1", oldUserName: "\ud800" }],
  ["jira.anonymization-validation", { userKey: "U1\u0000" }],
  ["jira.anonymization-progress", { taskId: "0" }],
  ["jira.anonymization-progress", { taskId: 7 }],
  ["jira.anonymization-progress", { taskId: "9223372036854775808" }],
  ["jira.anonymization-progress", { url: "https://untrusted.invalid" }],
] as const)(
  "refuses unbound or effect-bearing %s selectors before any request",
  async (name, args) => {
    const request = port({ ok: false, reason: "timeout" });
    expect((await read(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(JIRA_ANONYMIZATION_READS)(
  "does not admit credentials or alternate methods for %s",
  async (name) => {
    const extra: readonly CatalogJsonObject[] = [
      { password: "not-sent" },
      { method: "POST" },
      { unlock: true },
    ];
    for (const fields of extra) {
      const request = port({ ok: false, reason: "timeout" });
      const args = name === "jira.anonymization-progress" ? fields : { userKey: "U1", ...fields };
      expect((await read(name, args, request)).data.reason).toBe("invalid-input");
      expect(request).not.toHaveBeenCalled();
    }
  },
);
it.each([
  {},
  { userKey: "another-user" },
  { userKey: "U1", success: "false" },
  { userKey: "U1", operations: ["step", "step"] },
  { userKey: "U1", operations: [""] },
  { userKey: "U1", errors: [] },
  { userKey: "U1", errors: { GENERAL: { errorMessages: [7] } } },
  { userKey: "U1", warnings: { GENERAL: { errors: { field: false } } } },
])(
  "refuses malformed or foreign native validation without a successful prefix: %j",
  async (body) => {
    expect(
      (await read("jira.anonymization-validation", { userKey: "U1" }, success(body))).data.reason,
    ).toBe("malformed-payload");
  },
);
it.each([
  {
    userKey: "U1",
    operations: Array.from(
      { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
      (_, i) => `step${String(i)}`,
    ),
  },
  { userKey: "U1", errors: { GENERAL: { errorMessages: ["x".repeat(4097)] } } },
  {
    userKey: "U1",
    warnings: Object.fromEntries(
      Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, i) => [String(i), {}]),
    ),
  },
  { userKey: "U1", displayName: "x".repeat(256) },
])("reports exceeded native validation bounds rather than a partial success: %#", async (body) => {
  expect(
    (await read("jira.anonymization-validation", { userKey: "U1" }, success(body))).data.reason,
  ).toBe("bounds-exceeded");
});
it("refuses unsafe native numeric progress without rounding it", async () => {
  expect(
    (
      await read(
        "jira.anonymization-progress",
        {},
        success({ userKey: "U1", currentProgress: Number.MAX_SAFE_INTEGER + 1 }),
      )
    ).data.reason,
  ).toBe("bounds-exceeded");
});
it.each([
  { ok: false, reason: "permission-denied", httpStatus: 403 },
  { ok: false, reason: "not-found", httpStatus: 404 },
  { ok: false, reason: "unavailable", httpStatus: 400 },
] as const)("preserves native refusal %j without scheduling or polling", async (failure) => {
  const request = port(failure);
  expect((await read("jira.anonymization-progress", {}, request)).data.reason).toBe(failure.reason);
  expect(request).toHaveBeenCalledTimes(1);
});
it("exposes only the three documented observations", () => {
  expect(JIRA_ANONYMIZATION_READS).toHaveLength(3);
  expect(isJiraAnonymizationRead("jira.anonymize-user")).toBe(false);
  expect(isJiraAnonymizationRead("jira.unlock-anonymization")).toBe(false);
});

it("adds a task review only when all owner/task facts are actually supplied", async () => {
  const complete = {
    userKey: "target",
    executingNode: "owner-node",
    submittedTime: "native-time",
    status: "RUNNING",
    isRerun: false,
    currentProgress: 0,
    operations: [],
    userName: null,
    startTime: null,
  };
  expect(
    (await read("jira.anonymization-progress", {}, success(complete))).data.reviewSnapshot,
  ).toEqual(complete);
  for (const omitted of [
    "executingNode",
    "submittedTime",
    "status",
    "isRerun",
    "currentProgress",
    "operations",
  ]) {
    const incomplete: Record<string, unknown> = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== omitted),
    );
    const result = await read("jira.anonymization-progress", {}, success(incomplete));
    expect(result.data.outcome).toBe("succeeded");
    expect(result.data).not.toHaveProperty("reviewSnapshot");
    expect(result.data).not.toHaveProperty("shutdownVerified");
  }
});
