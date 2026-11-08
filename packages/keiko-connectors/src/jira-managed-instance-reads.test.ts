import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  executeJiraInstanceRead,
  isJiraInstanceRead,
  JIRA_INSTANCE_READS,
} from "./jira-managed-instance-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

const USER = { key: "user-7", name: "Synthetic", displayName: "Synthetic User", active: true };
const SERVER = {
  version: "11.3.13",
  versionNumbers: [11, 3, 13],
  deploymentType: "Data Center",
  buildNumber: 11030013,
  serverTitle: "Synthetic Jira",
};
function request(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}

it("projects server observations without following URLs or changing verification facts", async () => {
  const port = request({
    ...SERVER,
    baseUrl: "https://untrusted.invalid/other",
    healthChecks: [
      { name: "Confidential diagnostic", description: "Internal contents", passed: true },
    ],
    scmInfo: "internal-revision",
    serverTime: "2026-11-07T22:00:00Z",
    compatibility: { agileApi: "available" },
  });
  expect((await executeJiraInstanceRead("jira.server-info", {}, port)).data).toEqual({
    outcome: "succeeded",
    ...SERVER,
    buildNumber: "11030013",
    configuredBaseUrlState: "observed",
    configuredBaseUrl: "https://untrusted.invalid/other",
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("serverInfo", "GET", undefined, "json");
});
it("retains exact string build identifiers above JavaScript's safe integer range", async () => {
  const port = request({
    version: "11.4-SNAPSHOT",
    buildNumber: "9007199254740993",
    databaseBuildNumber: 0,
  });
  expect((await executeJiraInstanceRead("jira.server-info", {}, port)).data).toEqual({
    outcome: "succeeded",
    version: "11.4-SNAPSHOT",
    buildNumber: "9007199254740993",
    databaseBuildNumber: "0",
    configuredBaseUrlState: "unavailable",
  });
});
it("preserves version observations without claiming compatibility or health", async () => {
  const port = request({ version: "11.4-SNAPSHOT", versionNumbers: [11, 4, 0] });
  expect((await executeJiraInstanceRead("jira.server-info", {}, port)).data).toEqual({
    outcome: "succeeded",
    version: "11.4-SNAPSHOT",
    versionNumbers: [11, 4, 0],
    configuredBaseUrlState: "unavailable",
  });
});
it.each([
  undefined,
  null,
  "",
  "not a URL",
  "https://user:password@remote.invalid",
  "https://remote.invalid?",
  "https://remote.invalid#",
  "https://remote.invalid\\path",
  "https://remote.invalid/\ud800",
])(
  "withholds unsafe/unavailable configured base metadata %j without routing to it",
  async (baseUrl) => {
    const port = request({ ...SERVER, baseUrl });
    const result = await executeJiraInstanceRead("jira.server-info", {}, port);
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      configuredBaseUrlState: "unavailable",
    });
    expect(result.data).not.toHaveProperty("configuredBaseUrl");
    expect(port).toHaveBeenCalledExactlyOnceWith("serverInfo", "GET", undefined, "json");
  },
);
it("retains a native HTTP configured base only as a comparison fact", async () => {
  const port = request({ ...SERVER, baseUrl: "http://proxy.synthetic.invalid/jira" });
  expect((await executeJiraInstanceRead("jira.server-info", {}, port)).data).toMatchObject({
    configuredBaseUrlState: "observed",
    configuredBaseUrl: "http://proxy.synthetic.invalid/jira",
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("serverInfo", "GET", undefined, "json");
});
it.each([
  { version: "" },
  { versionNumbers: [] },
  { versionNumbers: [11, "3", 13] },
  { buildNumber: 9007199254740992 },
  { buildNumber: "9223372036854775808" },
  { buildNumber: "01" },
  { databaseBuildNumber: -1 },
  { serverTitle: 7 },
])("refuses malformed or inexact server metadata: %j", async (changed) => {
  const result = await executeJiraInstanceRead(
    "jira.server-info",
    {},
    request({ ...SERVER, ...changed }),
  );
  expect(result.data.reason).toBe("malformed-payload");
});
it("distinguishes observed false, missing features and actual time configuration", async () => {
  const configuration = {
    watchingEnabled: false,
    votingEnabled: true,
    timeTrackingEnabled: false,
    timeTrackingConfiguration: {
      workingHoursPerDay: 7.5,
      workingDaysPerWeek: 4,
      defaultUnit: "hour",
      timeFormat: "pretty",
    },
  };
  const port = request({
    ...configuration,
    attachmentsEnabled: null,
    arbitraryConfiguration: "private",
  });
  expect((await executeJiraInstanceRead("jira.instance-configuration", {}, port)).data).toEqual({
    outcome: "succeeded",
    ...configuration,
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("configuration", "GET", undefined, "json");
});
it("preserves a supplied zero without replacing unprovided time settings", async () => {
  const port = request({
    timeTrackingEnabled: true,
    timeTrackingConfiguration: { workingHoursPerDay: 0 },
  });
  expect((await executeJiraInstanceRead("jira.instance-configuration", {}, port)).data).toEqual({
    outcome: "succeeded",
    timeTrackingEnabled: true,
    timeTrackingConfiguration: { workingHoursPerDay: 0 },
  });
});
it.each([
  {},
  { watchingEnabled: "false" },
  { timeTrackingConfiguration: [] },
  { timeTrackingConfiguration: { workingDaysPerWeek: -1 } },
  { timeTrackingConfiguration: { defaultUnit: "months" } },
  { timeTrackingConfiguration: { timeFormat: "html" } },
])("refuses malformed instance configuration: %j", async (body) => {
  expect(
    (await executeJiraInstanceRead("jira.instance-configuration", {}, request(body))).data.reason,
  ).toBe("malformed-payload");
});
it("pages permission definitions locally without claiming effective actor permissions", async () => {
  const port = request({
    permissions: {
      BULK_CHANGE: { key: "BULK_CHANGE", name: "Bulk Change", type: "GLOBAL" },
      EDIT_ISSUE: {
        id: "12",
        key: "EDIT_ISSUES",
        name: "Edit Issues",
        type: "PROJECT",
        description: "Edit allowed issue fields.",
        havePermission: true,
      },
    },
  });
  expect(
    (
      await executeJiraInstanceRead(
        "jira.permission-definitions",
        { startAt: 1, maxResults: 1 },
        port,
      )
    ).data,
  ).toEqual({
    outcome: "succeeded",
    permissionsScope: "definitions",
    startAt: 1,
    total: 2,
    items: [
      {
        key: "EDIT_ISSUE",
        nativeKey: "EDIT_ISSUES",
        id: "12",
        name: "Edit Issues",
        type: "PROJECT",
        description: "Edit allowed issue fields.",
      },
    ],
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("permissions", "GET", undefined, "json");
});
it("retains observed empty definitions without inventing actor rights", async () => {
  expect(
    (await executeJiraInstanceRead("jira.permission-definitions", {}, request({ permissions: {} })))
      .data,
  ).toEqual({
    outcome: "succeeded",
    permissionsScope: "definitions",
    startAt: 0,
    total: 0,
    items: [],
  });
});
it("retains plugin permission keys while leaving optional fields unknown", async () => {
  const port = request({
    permissions: { "plugin:CUSTOM": { type: "PROJECT", havePermission: false } },
  });
  expect(
    (await executeJiraInstanceRead("jira.permission-definitions", {}, port)).data.items,
  ).toEqual([{ key: "plugin:CUSTOM", type: "PROJECT" }]);
});
it.each([
  { permissions: [] },
  { permissions: { BAD: null } },
  { permissions: { BAD: { type: 7 } } },
  { permissions: { BAD: { type: "PLUGIN" } } },
])("refuses malformed permission definitions: %j", async (body) => {
  expect(
    (await executeJiraInstanceRead("jira.permission-definitions", {}, request(body))).data.reason,
  ).toBe("malformed-payload");
});
it("refuses an over-budget definition collection without returning a silently incomplete page", async () => {
  const permissions = Object.fromEntries(
    Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => [
      `PERMISSION_${index}`,
      { name: `Permission ${index}` },
    ]),
  );
  const port = request({ permissions });
  expect((await executeJiraInstanceRead("jira.permission-definitions", {}, port)).data.reason).toBe(
    "bounds-exceeded",
  );
  expect(port).toHaveBeenCalledTimes(1);
});
it("reads only the current authenticated actor and excludes expanded email/URLs", async () => {
  const port = request({
    ...USER,
    emailAddress: "synthetic@example.invalid",
    self: "https://untrusted.invalid/user",
    groups: { items: ["private"] },
  });
  expect((await executeJiraInstanceRead("jira.myself", {}, port)).data).toEqual({
    outcome: "succeeded",
    ...USER,
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("myself", "GET", undefined, "json");
});
it.each(JIRA_INSTANCE_READS)(
  "refuses undeclared authority/target inputs for %s before transport",
  async (name) => {
    const port = request(SERVER);
    const args: CatalogJsonObject = {
      url: "https://untrusted.invalid",
      method: "POST",
      username: "other",
    };
    expect((await executeJiraInstanceRead(name, args, port)).data.reason).toBe("invalid-input");
    expect(port).not.toHaveBeenCalled();
  },
);
it.each(JIRA_INSTANCE_READS)(
  "preserves permission failures for %s without alternate discovery",
  async (name) => {
    const port = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraInstanceRead(name, {}, port)).data).toEqual({
      outcome: "failed",
      reason: "permission-denied",
    });
    expect(port).toHaveBeenCalledTimes(1);
  },
);
it("does not treat a related administrative write as an observational read", () => {
  expect(isJiraInstanceRead("jira.server-info")).toBe(true);
  expect(isJiraInstanceRead("jira.update-configuration")).toBe(false);
});
