import { expect, it, vi, type Mock } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraApplicationSettingsRead as read,
  isJiraApplicationSettingsRead,
  JIRA_APPLICATION_SETTINGS_READS,
} from "./jira-managed-application-settings.js";

function objectRequest(body: Record<string, unknown>): Mock<JiraMutationRequest> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function arrayRequest(items: readonly unknown[]): Mock<JiraMutationRequest> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
function scalarRequest(scalar: string | boolean | number | null): Mock<JiraMutationRequest> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, scalar });
}
it.each([
  "jira.clone.prefix",
  "jira.option.voting",
  "jira.option.watching",
  "jira.option.timetracking",
])("binds the requested application key %s exactly", async (key) => {
  const value = key === "jira.clone.prefix" ? "CLONE -" : "false";
  const port = objectRequest({ key, value });
  const result = await read("jira.application-properties", { key }, port);
  expect(result.data).toMatchObject({
    outcome: "succeeded",
    key,
    valueState: "observed",
    settingsScope: "application-properties",
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    `application-properties?key=${key}`,
    "GET",
    undefined,
    "json-object-or-array",
  );
});
it("supports only one matching property in the published array variant of a selected key", async () => {
  const args = { key: "jira.clone.prefix" };
  expect(
    (await read("jira.application-properties", args, arrayRequest([{ key: args.key, value: "" }])))
      .data,
  ).toMatchObject({ key: args.key, stringValue: "", valueState: "observed" });
  for (const rows of [
    [],
    [{ key: "jira.option.voting", value: "true" }],
    [{ key: args.key }, { key: args.key }],
  ])
    expect((await read("jira.application-properties", args, arrayRequest(rows))).data.reason).toBe(
      "malformed-payload",
    );
});
it("withholds unknown configuration data without reading value/default/example accessors", async () => {
  const observed = vi.fn(() => "private diagnostic setting");
  const body = {
    key: "plugin.connection.password",
    get value(): string {
      return observed();
    },
    get example(): string {
      return observed();
    },
    get defaultValue(): string {
      return observed();
    },
    get allowedValues(): string {
      return observed();
    },
  };
  expect(
    (await read("jira.application-properties", { key: body.key }, objectRequest(body))).data,
  ).toEqual({
    outcome: "succeeded",
    settingsScope: "application-properties",
    key: body.key,
    valueState: "withheld",
  });
  expect(observed).not.toHaveBeenCalled();
});
it("never treats unknown keys resembling object properties as documented values", async () => {
  for (const key of ["constructor", "toString", "__proto__", "jira.home"])
    expect(
      (
        await read(
          "jira.application-properties",
          { key },
          objectRequest({ key, value: "withheld native text" }),
        )
      ).data,
    ).toEqual({
      outcome: "succeeded",
      settingsScope: "application-properties",
      key,
      valueState: "withheld",
    });
});
it("locally pages the full permission-filtered list without native offset or regex", async () => {
  const port = arrayRequest([
    { key: "jira.home", value: "withheld path" },
    { key: "jira.option.watching", value: "false" },
  ]);
  expect(
    (await read("jira.application-properties", { permissionLevel: "ADMIN", maxResults: 1 }, port))
      .data,
  ).toEqual({
    outcome: "succeeded",
    settingsScope: "application-properties",
    permissionLevel: "ADMIN",
    items: [{ key: "jira.home", valueState: "withheld" }],
    startAt: 0,
    total: 2,
    nextStartAt: 1,
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    "application-properties?permissionLevel=ADMIN",
    "GET",
    undefined,
    "json-array",
  );
});
it("reads the advanced-settings native array, preserving missing values separately from false", async () => {
  const port = arrayRequest([
    { key: "jira.option.voting", value: "false", defaultValue: "true" },
    { key: "jira.clone.prefix", value: null },
  ]);
  expect((await read("jira.advanced-settings", {}, port)).data).toEqual({
    outcome: "succeeded",
    settingsScope: "advanced-settings",
    startAt: 0,
    total: 2,
    items: [
      {
        key: "jira.option.voting",
        valueState: "observed",
        valueType: "boolean",
        booleanValue: false,
      },
      { key: "jira.clone.prefix", valueState: "unknown", valueType: "string" },
    ],
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    "application-properties/advanced-settings",
    "GET",
    undefined,
    "json-array",
  );
});
it.each([
  ["jira.user.locale", "", { valueType: "string", stringValue: "" }],
  ["jira.user.timezone", "Europe/Berlin", { valueType: "string", stringValue: "Europe/Berlin" }],
  ["user.notifications.mimetype", "text/html", { valueType: "string", stringValue: "text/html" }],
  ["user.issues.per.page", "0", { valueType: "integer", integerValue: 0 }],
  ["user.issues.per.page", "-1", { valueType: "integer", integerValue: -1 }],
  ["user.keyboard.shortcuts.disabled", "false", { valueType: "boolean", booleanValue: false }],
  ["user.notify.own.changes", "true", { valueType: "boolean", booleanValue: true }],
] as const)(
  "projects the native preference string for %s through its fixed documented type",
  async (key, value, expected) => {
    const port = scalarRequest(value);
    expect((await read("jira.my-preference", { key }, port)).data).toEqual({
      outcome: "succeeded",
      settingsScope: "current-user-preference",
      key,
      valueState: "observed",
      ...expected,
    });
    expect(port).toHaveBeenCalledExactlyOnceWith(
      `mypreferences?key=${key}`,
      "GET",
      undefined,
      "json-scalar",
    );
  },
);
it("keeps unknown preference values withheld and never parses JSON inside native strings", async () => {
  const value = '{"unexpected":"native text"}';
  expect(
    (await read("jira.my-preference", { key: "plugin.private.preference" }, scalarRequest(value)))
      .data,
  ).toEqual({
    outcome: "succeeded",
    settingsScope: "current-user-preference",
    key: "plugin.private.preference",
    valueState: "withheld",
  });
  expect(
    (await read("jira.my-preference", { key: "jira.user.locale" }, scalarRequest(value))).data
      .stringValue,
  ).toBe(value);
});
it("keeps absent/null known values unknown without defaults", async () => {
  expect(
    (await read("jira.my-preference", { key: "user.notify.own.changes" }, scalarRequest(null)))
      .data,
  ).toMatchObject({ valueState: "unknown", valueType: "boolean" });
  expect(
    (
      await read(
        "jira.application-properties",
        { key: "jira.option.voting" },
        objectRequest({ key: "jira.option.voting", defaultValue: "false" }),
      )
    ).data,
  ).toMatchObject({ valueState: "unknown", valueType: "boolean" });
});
it.each(["TRUE", "1", "", " false ", true, 0])(
  "refuses coercion of an unexpected native preference boolean: %j",
  async (value) => {
    expect(
      (await read("jira.my-preference", { key: "user.notify.own.changes" }, scalarRequest(value)))
        .data.reason,
    ).toBe("malformed-payload");
  },
);
it.each(["0.5", "01", "-0", "1e2", "NaN"])(
  "refuses noncanonical preference integers: %s",
  async (value) => {
    expect(
      (await read("jira.my-preference", { key: "user.issues.per.page" }, scalarRequest(value))).data
        .reason,
    ).toBe("malformed-payload");
  },
);
it("classifies known value limits without rounding or truncating", async () => {
  expect(
    (
      await read(
        "jira.my-preference",
        { key: "user.issues.per.page" },
        scalarRequest("9007199254740992"),
      )
    ).data.reason,
  ).toBe("bounds-exceeded");
  expect(
    (await read("jira.my-preference", { key: "jira.user.locale" }, scalarRequest("a".repeat(4097))))
      .data.reason,
  ).toBe("bounds-exceeded");
  expect(
    (await read("jira.my-preference", { key: "jira.user.locale" }, scalarRequest("\ud800"))).data
      .reason,
  ).toBe("malformed-payload");
});
it("rejects malformed and oversized collections before local slicing", async () => {
  const valid = { key: "jira.clone.prefix", value: "" };
  expect(
    (
      await read(
        "jira.advanced-settings",
        { maxResults: 1 },
        arrayRequest([valid, { key: "jira.option.voting", value: "not-boolean" }]),
      )
    ).data.reason,
  ).toBe("malformed-payload");
  expect((await read("jira.advanced-settings", {}, arrayRequest([valid, valid]))).data.reason).toBe(
    "malformed-payload",
  );
  expect(
    (
      await read(
        "jira.advanced-settings",
        {},
        arrayRequest(
          Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
            key: `plugin.setting.${String(index)}`,
          })),
        ),
      )
    ).data.reason,
  ).toBe("bounds-exceeded");
});
it.each([
  ["jira.application-properties", {}],
  ["jira.application-properties", { key: "jira.home", permissionLevel: "SYSADMIN" }],
  ["jira.application-properties", { key: "jira.home", startAt: 0 }],
  ["jira.application-properties", { permissionLevel: "SYSADMIN_ONLY" }],
  ["jira.application-properties", { permissionLevel: "ADMIN", keyFilter: "jira.*" }],
  ["jira.advanced-settings", { startAt: null }],
  ["jira.advanced-settings", { maxResults: 101 }],
  ["jira.my-preference", { key: "" }],
  ["jira.my-preference", { key: "\ud800" }],
  ["jira.my-preference", { key: "jira.user.locale", value: "de_DE" }],
] as const)("refuses unsupported selectors for %s before native HTTP", async (name, input) => {
  const port = scalarRequest("unread");
  expect((await read(name, input, port)).data.reason).toBe("invalid-input");
  expect(port).not.toHaveBeenCalled();
});
it.each(JIRA_APPLICATION_SETTINGS_READS)(
  "preserves native failures on %s without fallback lookup",
  async (name) => {
    const port = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    const args = name === "jira.advanced-settings" ? {} : { key: "jira.clone.prefix" };
    expect((await read(name, args, port)).data.reason).toBe("permission-denied");
    expect(port).toHaveBeenCalledTimes(1);
  },
);
it("contains only the three fixed read tools", () => {
  expect(isJiraApplicationSettingsRead("jira.my-preference")).toBe(true);
  expect(isJiraApplicationSettingsRead("jira.set-preference")).toBe(false);
  expect(isJiraApplicationSettingsRead("constructor")).toBe(false);
});
