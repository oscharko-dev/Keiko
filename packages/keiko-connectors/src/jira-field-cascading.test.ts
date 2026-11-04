import { describe, expect, it } from "vitest";
import { parseJiraFieldMetadata, validateJiraFieldChanges } from "./jira-field-metadata.js";

const SYSTEM = "com.atlassian.jira.plugin.system.customfieldtypes:";
function customField(id: string, schema: Record<string, unknown>, extra: object = {}): object {
  return { fieldId: id, name: id, required: false, operations: ["set"], schema, ...extra };
}
type Parsed = ReturnType<typeof parseJiraFieldMetadata>;
function validate(result: Parsed, id: string, value: unknown): unknown {
  if (!result.ok) throw new Error("Invalid fixture");
  return validateJiraFieldChanges(result.fields, { [id]: value }, "edit", "data-center");
}

describe("a Jira cascading select (#4176)", () => {
  const allowedValues = [{ id: "100", value: "Parent", children: [{ id: "101", value: "Child" }] }];
  function cascading(type: string): Parsed {
    return parseJiraFieldMetadata([
      customField("customfield_5", { type, custom: `${SYSTEM}cascadingselect` }, { allowedValues }),
    ]);
  }

  it.each(["option-with-child", "option"])(
    "accepts a parent with a child when Jira declares the type %s",
    (type) => {
      const result = cascading(type);
      expect(result).toMatchObject({
        ok: true,
        fields: [{ kind: "option", schemaType: "option-with-child", operations: ["set"] }],
      });
      expect(validate(result, "customfield_5", { id: "100", child: { id: "101" } })).toEqual({
        ok: true,
        fields: { customfield_5: { id: "100", child: { id: "101" } } },
        update: {},
      });
      expect(validate(result, "customfield_5", { id: "100" })).toEqual({
        ok: true,
        fields: { customfield_5: { id: "100" } },
        update: {},
      });
    },
  );

  it.each([
    ["an unknown key beside the parent", { id: "100", value: "Parent" }],
    ["an unknown key beside the child", { id: "100", child: { id: "101", value: "Child" } }],
    ["a grandchild", { id: "100", child: { id: "101", child: { id: "102" } } }],
    ["a non-object child", { id: "100", child: "101" }],
    ["a null child", { id: "100", child: null }],
    ["an array child", { id: "100", child: [{ id: "101" }] }],
    ["a child without an id", { id: "100", child: {} }],
    ["a parent that is not allowed", { id: "999", child: { id: "101" } }],
    ["a child with an over-long id", { id: "100", child: { id: "1".repeat(257) } }],
    ["a child alone", { child: { id: "101" } }],
    ["a bare string", "100"],
  ])("refuses %s", (_, value) => {
    expect(validate(cascading("option-with-child"), "customfield_5", value)).toMatchObject({
      ok: false,
      reason: "invalid-field",
      fieldId: "customfield_5",
    });
  });

  it("keeps a plain option to exactly one id", () => {
    const result = parseJiraFieldMetadata([
      customField("customfield_6", { type: "option", custom: `${SYSTEM}select` }),
    ]);
    expect(validate(result, "customfield_6", { id: "1", child: { id: "2" } })).toMatchObject({
      ok: false,
      reason: "invalid-field",
    });
  });

  it("falls back to the bounded opaque value for a cascading select of another type", () => {
    const result = cascading("any");
    expect(result).toMatchObject({ ok: true, fields: [{ kind: "opaque" }] });
  });
});

describe("an unmapped system custom type whose shape is not implemented", () => {
  it.each(["option", "user", "group", "project", "option-with-child"])(
    "takes the bounded opaque path when it is declared as %s",
    (type) => {
      const result = parseJiraFieldMetadata([
        customField("customfield_7", { type, custom: `${SYSTEM}somethingnew` }),
      ]);
      expect(result).toMatchObject({ ok: true, fields: [{ kind: "opaque" }] });
      expect(validate(result, "customfield_7", { id: "1", child: { id: "2" } })).toMatchObject({
        ok: true,
      });
    },
  );

  it("keeps a plain scalar on its declared scalar kind", () => {
    const result = parseJiraFieldMetadata([
      customField("customfield_8", { type: "string", custom: `${SYSTEM}url` }),
    ]);
    expect(result).toMatchObject({ ok: true, fields: [{ kind: "text" }] });
  });
});
