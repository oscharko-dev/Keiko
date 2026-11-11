import { describe, expect, it } from "vitest";
import { jiraApplicationSettingsDetails as details } from "./jira-application-settings-presentation";

function preference(
  value: Readonly<Record<string, unknown>>,
): ReturnType<typeof details>[number] | undefined {
  return details("jira_my_preference", {
    outcome: "succeeded",
    key: "jira.user.locale",
    ...value,
  }).at(-1);
}
describe("typed Jira application setting observations", () => {
  it.each([
    [true, "true"],
    [false, "false"],
  ] as const)("preserves the boolean %s", (value, label) => {
    expect(
      preference({ valueState: "observed", valueType: "boolean", booleanValue: value })?.labels,
    ).toEqual([`chat.jira.settings.${label}`]);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER])(
    "preserves integer %s without deriving sentinel meanings",
    (value) => {
      expect(
        preference({ valueState: "observed", valueType: "integer", integerValue: value })?.facts,
      ).toContainEqual({ label: "chat.jira.settings.integerValue", value: String(value) });
    },
  );
  it.each(["0", "false", "<b>native text</b>", '{"nested":"still text"}'])(
    "preserves native text %s without parsing it",
    (value) => {
      expect(
        preference({ valueState: "observed", valueType: "string", stringValue: value })?.facts,
      ).toContainEqual({ label: "chat.jira.settings.stringValue", value });
    },
  );
  it("keeps empty and whitespace-only text distinct", () => {
    expect(
      preference({ valueState: "observed", valueType: "string", stringValue: "" })?.labels,
    ).toEqual(["chat.jira.settings.emptyText"]);
    const whitespace = preference({
      valueState: "observed",
      valueType: "string",
      stringValue: " \t ",
    });
    expect(whitespace?.labels).toEqual(["chat.jira.settings.whitespaceText"]);
    expect(whitespace?.facts).toContainEqual({
      label: "chat.jira.settings.stringValue",
      value: " \t ",
    });
  });
  it.each(["unknown", "withheld"])(
    "does not reveal supplemental values for state %s",
    (valueState) => {
      const card = preference({
        valueState,
        valueType: "string",
        stringValue: "supplemental private value",
        defaultValue: "invented default",
        example: "invented example",
        allowedValues: ["invented option"],
      });
      expect(card).toEqual({
        facts: [{ label: "chat.jira.settings.key", value: "jira.user.locale" }],
        labels: [`chat.jira.settings.${valueState}`],
      });
    },
  );
  it.each([
    { valueType: "boolean", booleanValue: "false" },
    { valueType: "boolean", booleanValue: null },
    { valueType: "integer", integerValue: "0" },
    { valueType: "integer", integerValue: 0.5 },
    { valueType: "string", stringValue: undefined },
    { valueType: "string", stringValue: null },
    { valueType: "unknown", stringValue: "not a typed observation" },
  ])("keeps malformed saved typed values unknown: %j", (value) => {
    expect(preference({ valueState: "observed", ...value })?.labels).toEqual([
      "chat.jira.settings.unknown",
    ]);
  });
  it("does not replace an unknown list with a known empty list or count", () => {
    const unknown = details("jira_advanced_settings", { outcome: "succeeded" });
    expect(unknown.at(-1)?.labels).toEqual(["chat.jira.settings.listUnknown"]);
    expect(unknown[0]?.facts).toEqual([]);
    const empty = details("jira_advanced_settings", {
      outcome: "succeeded",
      items: [],
      startAt: 0,
      total: 0,
    });
    expect(empty.at(-1)?.labels).toEqual(["chat.jira.settings.emptyList"]);
    expect(empty[0]?.facts).toContainEqual({
      label: "chat.jira.settings.collectionCount",
      value: "0",
    });
  });
  it("labels the requested filter without inferring permission or showing default data", () => {
    const cards = details("jira_application_properties", {
      outcome: "succeeded",
      permissionLevel: "SYSADMIN",
      items: [
        { key: "plugin.private.setting", valueState: "withheld", stringValue: "not disclosed" },
      ],
      total: 1,
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.settings.permissionFilter",
      value: "SYSADMIN",
    });
    expect(cards[0]?.labels).toContain("chat.jira.settings.filterOnly");
    expect(cards[1]?.labels).toEqual(["chat.jira.settings.withheld"]);
  });
  it("does not turn failed or unrelated tools into setting observations", () => {
    expect(
      details("jira_my_preference", {
        outcome: "failed",
        key: "jira.user.locale",
        valueState: "observed",
        stringValue: "en",
      }),
    ).toEqual([]);
    expect(details("jira_issue", { outcome: "succeeded", items: [] })).toEqual([]);
  });
});
