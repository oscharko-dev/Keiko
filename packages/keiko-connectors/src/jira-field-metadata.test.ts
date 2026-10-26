import { describe, expect, it } from "vitest";
import { parseJiraFieldMetadata, validateJiraFieldChanges } from "./jira-field-metadata.js";

function field(
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fieldId: id,
    name: id,
    required: false,
    operations: ["set"],
    schema: { type, system: id },
    ...extra,
  };
}
const metadata = [
  field("summary", "string", { required: true }),
  field("description", "string"),
  field("labels", "array", {
    schema: { type: "array", items: "string", system: "labels" },
    operations: ["set", "add", "remove"],
  }),
  field("priority", "priority", { allowedValues: [{ id: "1", name: "High" }] }),
  field("assignee", "user"),
  field("duedate", "date"),
  field("customfield_10000", "string", {
    required: true,
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
    },
  }),
];

function parsed(): ReturnType<typeof parseJiraFieldMetadata> {
  return parseJiraFieldMetadata(metadata);
}

describe("bounded Jira metadata field/operation matrix", () => {
  it("validates required custom fields and preserves omission versus explicit clearing", () => {
    const fields = parsed();
    expect(fields.ok).toBe(true);
    if (!fields.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(fields.fields, { summary: "Issue" }, "create", "data-center"),
    ).toMatchObject({ ok: false, reason: "required-field", fieldId: "customfield_10000" });
    expect(
      validateJiraFieldChanges(
        fields.fields,
        { summary: "Issue", customfield_10000: "Required" },
        "create",
        "data-center",
      ),
    ).toEqual({
      ok: true,
      fields: { summary: "Issue", customfield_10000: "Required" },
      update: {},
    });
    expect(
      validateJiraFieldChanges(fields.fields, { description: null }, "edit", "data-center"),
    ).toEqual({ ok: true, fields: { description: null }, update: {} });
    expect(
      validateJiraFieldChanges(fields.fields, { summary: null }, "edit", "data-center"),
    ).toMatchObject({ ok: false, reason: "required-field" });
  });

  it("never guesses unknown plugin types from a familiar base type", () => {
    const result = parseJiraFieldMetadata([
      field("customfield_9", "string", {
        schema: { type: "string", custom: "external.plugin:script" },
      }),
    ]);
    expect(result).toMatchObject({ ok: true, fields: [{ kind: "unsupported" }] });
    if (!result.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(result.fields, { customfield_9: "value" }, "edit", "data-center"),
    ).toMatchObject({ ok: false, reason: "unsupported-field" });
  });

  it.each([
    { priority: { id: "2" } },
    { priority: { id: "1", arbitrary: "ignored?" } },
    { assignee: { accountId: "cloud-user" } },
    { duedate: "2026-02-30" },
    { worklog: { timeSpent: "1h" } },
    { summary: "x".repeat(256) },
  ])("rejects constrained, malformed, or undeclared changes: %j", (changes) => {
    const result = parsed();
    if (!result.ok) throw new Error("Invalid fixture");
    expect(validateJiraFieldChanges(result.fields, changes, "edit", "data-center").ok).toBe(false);
  });

  it("only permits implemented field/verb pairs and refuses compound replacement plus update", () => {
    const result = parsed();
    if (!result.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(result.fields, {}, "edit", "data-center", [
        { fieldId: "labels", operation: "add", value: "triage" },
      ]),
    ).toEqual({ ok: true, fields: {}, update: { labels: [{ add: "triage" }] } });
    expect(
      validateJiraFieldChanges(result.fields, {}, "edit", "data-center", [
        { fieldId: "summary", operation: "add", value: "x" },
      ]).ok,
    ).toBe(false);
    expect(
      validateJiraFieldChanges(result.fields, { labels: [] }, "edit", "data-center", [
        { fieldId: "labels", operation: "remove", value: "triage" },
      ]).ok,
    ).toBe(false);
  });

  it("keeps Cloud ADF and Data Center plain text separate", () => {
    const result = parsed();
    if (!result.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(result.fields, { description: "text" }, "edit", "data-center"),
    ).toMatchObject({ ok: true, fields: { description: "text" } });
    expect(
      validateJiraFieldChanges(result.fields, { description: "text" }, "edit", "cloud"),
    ).toMatchObject({ ok: true, fields: { description: { type: "doc", version: 1 } } });
  });

  it("refuses duplicated metadata, oversized pages and dangerous field keys", () => {
    expect(parseJiraFieldMetadata([metadata[0], metadata[0]]).ok).toBe(false);
    expect(
      parseJiraFieldMetadata(
        Array.from({ length: 501 }, (_, i) => field(`customfield_${String(i)}`, "string")),
      ).ok,
    ).toBe(false);
    expect(parseJiraFieldMetadata([field("__proto__", "string")]).ok).toBe(false);
  });
});

describe("Jira scalar, reference and metadata edge cases", () => {
  it.each([
    ["float", "number", 2.5, true],
    ["float", "number", Number.NaN, false],
    ["float", "number", Number.POSITIVE_INFINITY, false],
    ["float", "number", "2.5", false],
    ["datepicker", "date", "2024-02-29", true],
    ["datepicker", "date", "2025-02-29", false],
    ["datetime", "datetime", "2026-10-27T01:30:00+02:00", true],
    ["datetime", "datetime", "2026-10-27T24:00:00Z", false],
    ["datetime", "datetime", "2026-02-30T00:00:00Z", false],
  ] as const)("validates %s / %s / %s", (custom, type, value, expected) => {
    const meta = parseJiraFieldMetadata([
      field("customfield_1", type, {
        schema: { type, custom: `com.atlassian.jira.plugin.system.customfieldtypes:${custom}` },
      }),
    ]);
    if (!meta.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(meta.fields, { customfield_1: value }, "edit", "data-center").ok,
    ).toBe(expected);
  });

  it("uses Jira's declared create default without fabricating a field value", () => {
    const meta = parseJiraFieldMetadata([
      field("priority", "priority", { required: true, hasDefaultValue: true }),
    ]);
    if (!meta.ok) throw new Error("Invalid fixture");
    expect(validateJiraFieldChanges(meta.fields, {}, "create", "data-center")).toEqual({
      ok: true,
      fields: {},
      update: {},
    });
    expect(validateJiraFieldChanges(meta.fields, {}, "transition", "data-center")).toMatchObject({
      ok: false,
      reason: "required-field",
    });
  });

  it("keeps deployment-specific user identities and option lists constrained", () => {
    const meta = parseJiraFieldMetadata([
      field("assignee", "user", { allowedValues: [{ name: "alice", accountId: "cloud-a" }] }),
      field("customfield_2", "array", {
        schema: {
          type: "array",
          items: "option",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect",
        },
        allowedValues: [{ id: "9" }],
      }),
    ]);
    if (!meta.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(
        meta.fields,
        { assignee: { name: "alice" }, customfield_2: [{ id: "9" }] },
        "edit",
        "data-center",
      ).ok,
    ).toBe(true);
    expect(
      validateJiraFieldChanges(meta.fields, { assignee: { accountId: "cloud-a" } }, "edit", "cloud")
        .ok,
    ).toBe(true);
    expect(
      validateJiraFieldChanges(meta.fields, { assignee: { name: "other" } }, "edit", "data-center")
        .ok,
    ).toBe(false);
    expect(
      validateJiraFieldChanges(
        meta.fields,
        { customfield_2: [{ id: "10" }] },
        "edit",
        "data-center",
      ).ok,
    ).toBe(false);
  });

  it.each([
    null,
    [{ fieldId: "labels", operation: "add", value: "a", extra: true }],
    [{ fieldId: "labels", operation: "clear", value: "a" }],
  ])("rejects malformed update inputs", (updates) => {
    const meta = parsed();
    if (!meta.ok) throw new Error("Invalid fixture");
    expect(validateJiraFieldChanges(meta.fields, {}, "edit", "data-center", updates).ok).toBe(
      false,
    );
  });

  it("cannot use an unsupported labels schema to authorize an additive update", () => {
    const meta = parseJiraFieldMetadata([
      field("labels", "array", {
        schema: { type: "array", items: "user", system: "labels" },
        operations: ["add"],
      }),
    ]);
    if (!meta.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(meta.fields, {}, "edit", "data-center", [
        { fieldId: "labels", operation: "add", value: "a" },
      ]).ok,
    ).toBe(false);
  });
});
