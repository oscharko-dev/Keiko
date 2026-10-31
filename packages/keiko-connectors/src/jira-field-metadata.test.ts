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

it("accepts 50 implemented updates and rejects the next update before field execution", () => {
  const parsed = parseJiraFieldMetadata(metadata);
  if (!parsed.ok) throw new Error("Expected supported field metadata");
  const updates = Array.from({ length: 51 }, (_, index) => ({
    fieldId: "labels",
    operation: "add",
    value: `label-${String(index)}`,
  }));
  expect(
    validateJiraFieldChanges(parsed.fields, {}, "edit", "data-center", updates.slice(0, 50)).ok,
  ).toBe(true);
  expect(validateJiraFieldChanges(parsed.fields, {}, "edit", "data-center", updates)).toEqual({
    ok: false,
    reason: "bounds-exceeded",
  });
});

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

  // Owner decision 2026-10-31 (#4176, ADR-0128 bounded field validation): plugin fields are writable, but their meaning
  // is still never guessed from a familiar base type. The value stays opaque — no text semantics,
  // no rich-text conversion, no read-back equality claim — and Jira's validation decides.
  it("never guesses unknown plugin types from a familiar base type", () => {
    const result = parseJiraFieldMetadata([
      field("customfield_9", "string", {
        schema: { type: "string", custom: "external.plugin:script" },
      }),
    ]);
    expect(result).toMatchObject({
      ok: true,
      fields: [{ kind: "opaque", richText: false, schemaType: "string" }],
    });
    if (!result.ok) throw new Error("Invalid fixture");
    expect(
      validateJiraFieldChanges(result.fields, { customfield_9: "value" }, "edit", "data-center"),
    ).toEqual({ ok: true, fields: { customfield_9: "value" }, update: {} });
    expect(
      validateJiraFieldChanges(result.fields, { customfield_9: "value" }, "edit", "cloud"),
    ).toEqual({ ok: true, fields: { customfield_9: "value" }, update: {} });
  });

  it.each([
    { customfield_9: JSON.parse('{"__proto__":{"polluted":true}}') as unknown },
    { customfield_9: "x".repeat(4097) },
    { customfield_9: [[[[["too deep"]]]]] },
    { customfield_9: Array.from({ length: 101 }, (_, index) => index) },
    { customfield_9: "control\u0000character" },
    { customfield_9: Number.POSITIVE_INFINITY },
  ])("bounds an opaque plugin value: %j", (changes) => {
    const result = parseJiraFieldMetadata([
      field("customfield_9", "any", { schema: { type: "any", custom: "vendor:link" } }),
    ]);
    if (!result.ok) throw new Error("Invalid fixture");
    expect(validateJiraFieldChanges(result.fields, changes, "edit", "data-center")).toMatchObject({
      ok: false,
      reason: "invalid-field",
      fieldId: "customfield_9",
    });
  });

  it("writes a parent issue reference only as one canonical key or id", () => {
    const result = parseJiraFieldMetadata([
      field("parent", "issuelink", { schema: { type: "issuelink", system: "parent" } }),
    ]);
    if (!result.ok) throw new Error("Invalid fixture");
    expect(result.fields[0]).toMatchObject({ kind: "issue", operations: ["set"] });
    const write = (parent: unknown): unknown =>
      validateJiraFieldChanges(result.fields, { parent }, "edit", "data-center");
    expect(write("REQ-12")).toMatchObject({ ok: true, fields: { parent: { key: "REQ-12" } } });
    expect(write({ id: "10001" })).toMatchObject({ ok: true, fields: { parent: { id: "10001" } } });
    for (const invalid of ["REQ", "12", { key: "REQ-1", id: "1" }, { key: "REQ 1" }])
      expect(write(invalid)).toMatchObject({ ok: false, reason: "invalid-field" });
  });

  it("keeps dedicated system fields out of plain field writes", () => {
    const result = parseJiraFieldMetadata([
      field("attachment", "array", {
        schema: { type: "array", items: "attachment", system: "attachment" },
      }),
      field("issuelinks", "array", {
        schema: { type: "array", items: "issuelinks", system: "issuelinks" },
        operations: ["add"],
      }),
      field("timetracking", "timetracking", {
        schema: { type: "timetracking", system: "timetracking" },
      }),
    ]);
    if (!result.ok) throw new Error("Invalid fixture");
    expect(result.fields.map((item) => [item.id, item.kind, item.operations])).toEqual([
      ["attachment", "unsupported", []],
      ["issuelinks", "links", ["add"]],
      ["timetracking", "opaque", ["set"]],
    ]);
    // Links travel only on the dedicated links argument (#4176), never as a plain field write.
    expect(
      validateJiraFieldChanges(
        result.fields,
        { issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "REQ-2" } }] },
        "edit",
        "data-center",
      ),
    ).toEqual({ ok: false, reason: "invalid-operation", fieldId: "issuelinks" });
    expect(
      validateJiraFieldChanges(result.fields, { attachment: [] }, "edit", "data-center"),
    ).toEqual({ ok: false, reason: "unsupported-field", fieldId: "attachment" });
  });

  it("offers issue links only with an add operation on the canonical schema", () => {
    const result = parseJiraFieldMetadata([
      field("issuelinks", "array", {
        schema: { type: "array", items: "issuelinks", system: "issuelinks" },
        operations: ["set"],
      }),
    ]);
    if (!result.ok) throw new Error("Invalid fixture");
    expect(result.fields.map((item) => [item.kind, item.operations])).toEqual([["links", []]]);
    const malformed = parseJiraFieldMetadata([
      field("issuelinks", "array", {
        schema: { type: "array", items: "string", system: "issuelinks" },
        operations: ["add"],
      }),
    ]);
    if (!malformed.ok) throw new Error("Invalid fixture");
    expect(malformed.fields[0]?.kind).toBe("unsupported");
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

it.each(["versions", "fixVersions", "components"])(
  "contains an oversized %s choice list to that field",
  (id) => {
    const result = parseJiraFieldMetadata([
      field("summary", "string", { required: true }),
      field(id, "array", {
        schema: { type: "array", system: id, items: id === "components" ? "component" : "version" },
        allowedValues: Array.from({ length: 501 }, (_, index) => ({ id: String(index) })),
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Unrelated field lost");
    expect(result.fields[1]).toMatchObject({ kind: "unsupported", operations: [] });
    expect(result.fields[1]).not.toHaveProperty("allowedValues");
    expect(
      validateJiraFieldChanges(result.fields, { summary: "Issue" }, "create", "data-center"),
    ).toMatchObject({ ok: true });
    expect(
      validateJiraFieldChanges(result.fields, { [id]: [{ id: "1" }] }, "edit", "data-center"),
    ).toMatchObject({ ok: false, reason: "unsupported-field", fieldId: id });
    const required = result.fields.map((item) =>
      item.id === id ? { ...item, required: true } : item,
    );
    expect(
      validateJiraFieldChanges(required, { summary: "Issue" }, "create", "data-center"),
    ).toMatchObject({ ok: false, reason: "unsupported-field", fieldId: id });
  },
);

it("does not parse plugin-specific choice structures for unsupported field kinds", () => {
  const result = parseJiraFieldMetadata([
    field("summary", "string"),
    field("customfield_9", "string", {
      schema: { type: "string", custom: "vendor:compound" },
      operations: ["set", "add"],
      allowedValues: [{ nested: { arbitraryPluginValue: true } }],
    }),
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Unrelated field lost");
  // The plugin value stays opaque: its choice structure is never parsed and only "set" exists.
  expect(result.fields[1]).toMatchObject({ kind: "opaque", operations: ["set"] });
  expect(result.fields[1]).not.toHaveProperty("allowedValues");
});

it("offers only the field/verb pairs implemented by the bounded mutation matrix", () => {
  const result = parseJiraFieldMetadata([
    field("components", "array", {
      schema: { type: "array", system: "components", items: "component" },
      operations: ["set", "add", "remove"],
    }),
    metadata[2],
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Invalid fixture");
  expect(result.fields.map((item) => item.operations)).toEqual([["set"], ["set", "add", "remove"]]);
});

it.each([{ allowedValues: { invalid: "not-a-list" } }, { allowedValues: [{}] }])(
  "still refuses structurally invalid references on a supported field",
  ({ allowedValues }) => {
    expect(parseJiraFieldMetadata([field("priority", "priority", { allowedValues })])).toEqual({
      ok: false,
      reason: "malformed-metadata",
    });
  },
);

it("retains human choice labels without admitting labels as write identities", () => {
  const parsed = parseJiraFieldMetadata([
    field("customfield_10001", "option", {
      schema: {
        type: "option",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:select",
      },
      allowedValues: [{ id: "21", value: "Blue", self: "private-url" }],
    }),
  ]);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("Invalid metadata fixture");
  expect(parsed.fields[0]?.allowedValues).toEqual([{ id: "21", label: "Blue" }]);
  expect(
    validateJiraFieldChanges(
      parsed.fields,
      { customfield_10001: { label: "Blue" } },
      "edit",
      "data-center",
    ).ok,
  ).toBe(false);
  expect(
    validateJiraFieldChanges(
      parsed.fields,
      { customfield_10001: { id: "21" } },
      "edit",
      "data-center",
    ).ok,
  ).toBe(true);
});
