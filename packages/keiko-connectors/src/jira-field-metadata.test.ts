import { describe, expect, it } from "vitest";
import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
    {
      customfield_9: Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [`k${String(index)}`, index]),
      ),
    },
    // Each string is within the scalar bound; together they pass the 16 KiB serialized bound.
    { customfield_9: Array.from({ length: 5 }, () => "x".repeat(4000)) },
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

  it.each([
    { customfield_9: "x".repeat(4096) },
    { customfield_9: Array.from({ length: 100 }, (_, index) => index) },
    {
      customfield_9: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`k${String(index)}`, index]),
      ),
    },
    { customfield_9: [[["at depth"]]] },
    { customfield_9: Array.from({ length: 3 }, () => "x".repeat(4000)) },
  ])("accepts an opaque plugin value exactly at its bounds: %j", (changes) => {
    const result = parseJiraFieldMetadata([
      field("customfield_9", "any", { schema: { type: "any", custom: "vendor:link" } }),
    ]);
    if (!result.ok) throw new Error("Invalid fixture");
    expect(validateJiraFieldChanges(result.fields, changes, "edit", "data-center")).toEqual({
      ok: true,
      fields: changes,
      update: {},
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

  // #4176 lab (S17): Jira sets the reporter to the caller when it is absent, although create
  // metadata lists it as required without a default. No other required field gets that grace.
  describe("the reporter of a new issue", () => {
    const meta = (): readonly JiraFieldMetadata[] => {
      const result = parseJiraFieldMetadata([
        field("summary", "string", { required: true }),
        field("reporter", "user", { required: true, hasDefaultValue: false }),
      ]);
      if (!result.ok) throw new Error("Invalid fixture");
      return result.fields;
    };
    it("may be omitted on create and is then not sent", () => {
      expect(validateJiraFieldChanges(meta(), { summary: "S" }, "create", "data-center")).toEqual({
        ok: true,
        fields: { summary: "S" },
        update: {},
      });
    });
    it("is still required for a transition and any other required field is still refused", () => {
      expect(validateJiraFieldChanges(meta(), {}, "create", "data-center")).toMatchObject({
        ok: false,
        reason: "required-field",
        fieldId: "summary",
      });
      expect(
        validateJiraFieldChanges(meta(), { summary: "S" }, "transition", "data-center"),
      ).toMatchObject({ ok: false, reason: "required-field", fieldId: "reporter" });
    });
    it("is validated like any user when supplied", () => {
      const supplied = (reporter: unknown): unknown =>
        validateJiraFieldChanges(meta(), { summary: "S", reporter }, "create", "data-center");
      expect(supplied("x".repeat(257))).toMatchObject({
        ok: false,
        reason: "invalid-field",
        fieldId: "reporter",
      });
      expect(supplied("")).toMatchObject({ ok: false, fieldId: "reporter" });
      expect(supplied(null)).toMatchObject({ ok: false, fieldId: "reporter" });
      expect(supplied("keiko-admin")).toMatchObject({
        ok: true,
        fields: { reporter: { name: "keiko-admin" } },
      });
    });
  });

  // #4176 lab (S05): models send the user or choice itself, not Jira's reference object. A bare
  // string is canonicalized to the one reference the deployment and the offered choices admit.
  describe("bare user and option values", () => {
    const parse = (...fields: Record<string, unknown>[]): readonly JiraFieldMetadata[] => {
      const result = parseJiraFieldMetadata(fields);
      if (!result.ok) throw new Error("Invalid fixture");
      return result.fields;
    };
    const check = (
      fields: readonly JiraFieldMetadata[],
      value: unknown,
      id: string,
      deployment: "data-center" | "cloud" = "data-center",
    ): unknown => validateJiraFieldChanges(fields, { [id]: value }, "edit", deployment);
    const OPTIONS = [
      { id: "10", value: "Blue" },
      { id: "11", value: "Green" },
      { id: "12", value: "Green" },
      { id: "Green-id", value: "Other" },
    ];
    const choice = (allowedValues?: unknown[]): readonly JiraFieldMetadata[] =>
      parse(
        field("customfield_5", "option", {
          schema: {
            type: "option",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:select",
          },
          ...(allowedValues === undefined ? {} : { allowedValues }),
        }),
      );
    it("turns a bare user name into the deployment's user key", () => {
      const fields = parse(field("reporter", "user"));
      expect(check(fields, "keiko-admin", "reporter")).toMatchObject({
        ok: true,
        fields: { reporter: { name: "keiko-admin" } },
      });
      expect(check(fields, "5b10ac8d82e05b22cc7d4ef5", "reporter", "cloud")).toMatchObject({
        ok: true,
        fields: { reporter: { accountId: "5b10ac8d82e05b22cc7d4ef5" } },
      });
      expect(check(fields, { name: "keiko-admin" }, "reporter")).toMatchObject({ ok: true });
    });
    it.each(["", " ", "x".repeat(257), "line\nbreak"])("refuses the bare user %j", (value) => {
      expect(check(parse(field("reporter", "user")), value, "reporter")).toMatchObject({
        ok: false,
        reason: "invalid-field",
      });
    });
    it("keeps a bare user inside the offered users", () => {
      const fields = parse(
        field("reporter", "user", { allowedValues: [{ name: "alice", accountId: "cloud-a" }] }),
      );
      expect(check(fields, "alice", "reporter")).toMatchObject({ ok: true });
      expect(check(fields, "bob", "reporter")).toMatchObject({ ok: false });
      expect(check(fields, "cloud-a", "reporter", "cloud")).toMatchObject({ ok: true });
      expect(check(fields, "alice", "reporter", "cloud")).toMatchObject({ ok: false });
    });
    it("accepts bare users in a user list", () => {
      const fields = parse(
        field("customfield_6", "array", {
          schema: {
            type: "array",
            items: "user",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker",
          },
        }),
      );
      expect(check(fields, ["alice", { name: "bob" }], "customfield_6")).toMatchObject({
        ok: true,
        fields: { customfield_6: [{ name: "alice" }, { name: "bob" }] },
      });
    });
    it("matches a bare option by id, then by exact value, and canonicalizes to the id", () => {
      const fields = choice(OPTIONS);
      expect(check(fields, "10", "customfield_5")).toMatchObject({
        ok: true,
        fields: { customfield_5: { id: "10" } },
      });
      expect(check(fields, "Blue", "customfield_5")).toMatchObject({
        ok: true,
        fields: { customfield_5: { id: "10" } },
      });
      // An id match wins over a value match: "Green-id" is an id, "Other" its value.
      expect(check(fields, "Green-id", "customfield_5")).toMatchObject({
        ok: true,
        fields: { customfield_5: { id: "Green-id" } },
      });
    });
    it("refuses a string that is one choice's id and another choice's name, with a message", () => {
      const fields = choice([
        { id: "10", value: "Blue" },
        { id: "11", value: "10" },
      ]);
      const ambiguous = check(fields, "10", "customfield_5") as { message?: string };
      expect(ambiguous).toMatchObject({
        ok: false,
        reason: "invalid-field",
        fieldId: "customfield_5",
      });
      expect(ambiguous.message).toContain("more than one offered choice");
      expect(check(fields, "Blue", "customfield_5")).toMatchObject({ ok: true });
      const unknown = check(fields, "nothing", "customfield_5") as { message?: string };
      expect(unknown).toMatchObject({ ok: false });
      expect(unknown.message).toContain("none of the offered choices");
    });
    it.each([
      ["an ambiguous value", "Green"],
      ["a value that is not offered", "Purple"],
      ["a different case", "blue"],
    ])("refuses a bare option with %s", (_label, value) => {
      expect(check(choice(OPTIONS), value, "customfield_5")).toMatchObject({
        ok: false,
        reason: "invalid-field",
      });
    });
    it("takes only a numeric id when no choices are listed", () => {
      const fields = choice();
      expect(check(fields, "10", "customfield_5")).toMatchObject({
        ok: true,
        fields: { customfield_5: { id: "10" } },
      });
      expect(check(fields, "Blue", "customfield_5")).toMatchObject({ ok: false });
      expect(check(fields, "10; drop", "customfield_5")).toMatchObject({ ok: false });
    });
    it("accepts bare choices in an option list and keeps the object form", () => {
      const fields = parse(
        field("components", "array", {
          schema: { type: "array", items: "component", system: "components" },
          allowedValues: [
            { id: "1", name: "Backend" },
            { id: "2", name: "Frontend" },
          ],
        }),
      );
      expect(check(fields, ["Backend", "2", { id: "1" }], "components")).toMatchObject({
        ok: true,
        fields: { components: [{ id: "1" }, { id: "2" }, { id: "1" }] },
      });
      expect(check(fields, ["Missing"], "components")).toMatchObject({ ok: false });
    });
    it("matches a bare priority or issue type by its name", () => {
      const fields = parse(
        field("priority", "priority", {
          allowedValues: [
            { id: "1", name: "High" },
            { id: "2", name: "Low" },
          ],
        }),
      );
      expect(check(fields, "High", "priority")).toMatchObject({
        ok: true,
        fields: { priority: { id: "1" } },
      });
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

describe("escaped line breaks in rich text (#4178)", () => {
  const fields = (): readonly JiraFieldMetadata[] => {
    const result = parsed();
    if (!result.ok) throw new Error("Invalid fixture");
    return result.fields;
  };
  const check = (
    description: string,
    deployment: "data-center" | "cloud" = "data-center",
  ): ReturnType<typeof validateJiraFieldChanges> =>
    validateJiraFieldChanges(fields(), { description }, "edit", deployment);
  const ESCAPED = String.raw`### Steps\n1. Build.\n\n### Definition of Done\n- Tested.`;

  it.each(["data-center", "cloud"] as const)(
    "refuses a description whose line breaks all arrive escaped (%s)",
    (deployment) => {
      expect(check(ESCAPED, deployment)).toEqual({
        ok: false,
        reason: "invalid-field",
        fieldId: "description",
        message:
          "The text contains escaped line breaks (\\n) and no real line break; send real line breaks instead.",
      });
    },
  );

  it("accepts real line breaks, one literal escape and an escape beside real breaks", () => {
    expect(check(ESCAPED.replaceAll(String.raw`\n`, "\n"))).toMatchObject({ ok: true });
    expect(check(String.raw`Split the CSV on \n before parsing.`)).toMatchObject({ ok: true });
    expect(check(`Regex:\n${String.raw`split on \n and \n again`}`)).toMatchObject({ ok: true });
  });

  it.each([
    String.raw`Split paragraphs with /\n\n/; preserve that regular expression literally.`,
    String.raw`Replace \n with a space, then \n again at the end.`,
    String.raw`Use "\n\n" as the separator and "\n" inside a record.`,
  ])("keeps intentional backslash text with several escapes (%s)", (description) => {
    for (const deployment of ["data-center", "cloud"] as const)
      expect(check(description, deployment)).toMatchObject({ ok: true });
  });

  it("still refuses an encoded document with headings or list items, whatever the escapes between", () => {
    for (const encoded of [
      String.raw`## Context\nWhy\n## Acceptance criteria\n* works`,
      String.raw`h2. Context\nWhy\nh2. Done\nTested`,
      String.raw`Steps\n- build\n- test`,
      String.raw`Intro\n\n1. First\n2. Second`,
    ])
      expect(check(encoded), encoded).toMatchObject({ ok: false, reason: "invalid-field" });
  });

  it("leaves single-line text fields alone", () => {
    expect(
      validateJiraFieldChanges(fields(), { summary: String.raw`a\nb\nc` }, "edit", "data-center"),
    ).toMatchObject({ ok: true });
  });
});
