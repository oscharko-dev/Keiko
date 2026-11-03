import { describe, expect, it } from "vitest";
import { jiraSelectedFieldValues, selectedJiraReadFields } from "./jira-managed-field-reads.js";
function projection(type: string, custom: string, value: unknown, items?: string): unknown {
  return jiraSelectedFieldValues(
    {
      fields: { customfield_1: value },
      names: { customfield_1: "Synthetic" },
      schema: {
        customfield_1: {
          type,
          custom: `com.atlassian.jira.plugin.system.customfieldtypes:${custom}`,
          ...(items === undefined ? {} : { items }),
        },
      },
    },
    ["customfield_1"],
  )?.[0];
}
describe("selected Jira field values", () => {
  it.each([
    ["number", "float", 0, undefined, { number: 0 }],
    ["date", "datepicker", "2026-10-27", undefined, { text: "2026-10-27" }],
    [
      "datetime",
      "datetime",
      "2026-10-27T10:00:00.000+0200",
      undefined,
      { text: "2026-10-27T08:00:00.000+0000" },
    ],
    [
      "user",
      "userpicker",
      { name: "reader", displayName: "Reader", emailAddress: "private-email" },
      undefined,
      { references: [{ name: "reader", label: "Reader" }] },
    ],
    [
      "option",
      "select",
      { id: "1", value: "First", self: "private-url" },
      undefined,
      { references: [{ id: "1", label: "First" }] },
    ],
    [
      "array",
      "multiselect",
      [{ id: "1", value: "First" }],
      "option",
      { references: [{ id: "1", label: "First" }] },
    ],
    [
      "array",
      "multiuserpicker",
      [{ name: "reader", displayName: "Reader" }],
      "user",
      { references: [{ name: "reader", label: "Reader" }] },
    ],
  ] as const)("projects supported %s/%s values", (type, custom, value, items, expected) => {
    expect(projection(type, custom, value, items)).toMatchObject({ state: "value", ...expected });
    expect(JSON.stringify(projection(type, custom, value, items))).not.toContain("private-");
  });
  it.each([
    ["date", "datepicker", "2026-02-30", undefined],
    ["number", "float", Number.MAX_VALUE, undefined],
    ["string", "textfield", "x".repeat(256), undefined],
    ["string", "textarea", { type: "doc" }, undefined],
    ["array", "multiselect", [{ id: "1" }, { id: "1" }], "option"],
    [
      "array",
      "multiuserpicker",
      Array.from({ length: 101 }, (_, i) => ({ name: String(i) })),
      "user",
    ],
  ] as const)(
    "marks malformed or unbounded %s/%s values unavailable",
    (type, custom, value, items) => {
      expect(projection(type, custom, value, items)).toMatchObject({ state: "unavailable" });
    },
  );
  it.each(
    [
      [],
      ["*all"],
      ["constructor"],
      ["customfield_1", "customfield_1"],
      Array.from({ length: 21 }, (_, i) => `customfield_${String(i)}`),
    ].map((fields) => ({ fields })),
  )("refuses unsafe or unbounded selection %j", ({ fields }) => {
    expect(selectedJiraReadFields(fields)).toBeUndefined();
  });
  it("keeps current empty strings and arrays distinct from missing values", () => {
    expect(projection("string", "textarea", "")).toMatchObject({ state: "empty" });
    expect(projection("array", "multiselect", [], "option")).toMatchObject({ state: "empty" });
    expect(projection("array", "multiselect", undefined, "option")).toMatchObject({
      state: "unavailable",
    });
  });
});

describe("aggregate field projection byte budget", () => {
  const selected = ["customfield_1", "customfield_2"];
  const body = {
    fields: { customfield_1: '漢"\\'.repeat(200), customfield_2: "second" },
    names: { customfield_1: '名"\\'.repeat(80), customfield_2: "Second" },
    schema: Object.fromEntries(
      selected.map((id) => [
        id,
        { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" },
      ]),
    ),
  };
  it("counts escaped UTF-8 bytes and keeps the exact fitting result", () => {
    const full = jiraSelectedFieldValues(body, selected);
    const bytes = Buffer.byteLength(JSON.stringify(full));
    expect(jiraSelectedFieldValues(body, selected, bytes)).toEqual(full);
    const bounded = jiraSelectedFieldValues(body, selected, bytes - 1);
    expect(bounded).toMatchObject([{ state: "value" }, { state: "unavailable" }]);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(bytes);
  });
  it("reserves every placeholder before admitting any field value", () => {
    const full = jiraSelectedFieldValues(body, selected);
    expect(full).toBeDefined();
    const first = full?.[0];
    expect(first).toBeDefined();
    const budget = Buffer.byteLength(JSON.stringify([first]));
    const bounded = jiraSelectedFieldValues(body, selected, budget);
    expect(bounded).toMatchObject([{ state: "unavailable" }, { state: "unavailable" }]);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(budget);
  });
  it.each([0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, 262145])(
    "refuses a budget that cannot hold the projection: %s",
    (bytes) => {
      expect(jiraSelectedFieldValues(body, selected, bytes)).toBeUndefined();
    },
  );
});
