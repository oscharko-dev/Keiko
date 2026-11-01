import { describe, expect, it } from "vitest";
import { jiraDraftExcluded, jiraDraftTree } from "./jiraDraftTree";

const item = (ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref,
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: `Item ${ref}` },
  ...extra,
});
const DRAFT = {
  items: [
    item("epic"),
    item("story", { parent: { fieldId: "customfield_10100", ref: "epic" } }),
    item("sub", { parent: { fieldId: "parent", ref: "story" }, fields: { summary: "S", x: 1 } }),
    item("bug", { links: [{ type: "Blocks", direction: "outward", ref: "sub" }] }),
    item("loose", { parent: { fieldId: "parent", issueKey: "SYN-7" } }),
  ],
};

describe("jiraDraftTree (#4178)", () => {
  it("nests items under their draft parent and keeps external parents and links readable", () => {
    const tree = jiraDraftTree(DRAFT);
    expect(tree?.refs).toEqual(["epic", "story", "sub", "bug", "loose"]);
    expect(tree?.roots.map((root) => root.ref)).toEqual(["epic", "bug", "loose"]);
    const [epic, bug, loose] = tree?.roots ?? [];
    expect(epic?.children[0]?.ref).toBe("story");
    expect(epic?.children[0]?.children[0]).toMatchObject({
      ref: "sub",
      projectId: "10000",
      issueTypeId: "10001",
      parentFieldId: "parent",
      parentRef: "story",
      fields: [{ id: "x", value: { kind: "text", text: "1" } }],
    });
    expect(bug?.links).toEqual([
      { type: "Blocks", direction: "outward", target: "sub", existing: false },
    ]);
    expect(loose).toMatchObject({ parentIssueKey: "SYN-7", children: [] });
  });

  it.each([
    ["no items", { items: [] }],
    ["a duplicate ref", { items: [item("a"), item("a")] }],
    ["a missing summary", { items: [{ ...item("a"), fields: {} }] }],
    ["an unreadable link", { items: [item("a", { links: [{ type: "Blocks" }] })] }],
    ["a missing project", { items: [{ ...item("a"), projectId: undefined }] }],
    ["a missing issue type", { items: [{ ...item("a"), issueTypeId: "" }] }],
    ["a parent without its field", { items: [item("a", { parent: { ref: "b" } })] }],
    [
      "a parent with two targets",
      { items: [item("a", { parent: { fieldId: "parent", ref: "b", issueKey: "SYN-1" } })] },
    ],
    ["not an object", "draft"],
  ])("shows no tree for %s", (_name, args) => {
    expect(jiraDraftTree(args)).toBeUndefined();
  });

  it("shows no tree, rather than hiding items, for a parent cycle the server refuses", () => {
    const tree = jiraDraftTree({
      items: [
        item("a", { parent: { fieldId: "parent", ref: "b" } }),
        item("b", { parent: { fieldId: "parent", ref: "a" } }),
      ],
    });
    expect(tree).toBeUndefined();
  });
});

describe("field values of a draft item (#4178)", () => {
  const fieldsOf = (fields: Record<string, unknown>): unknown =>
    jiraDraftTree({ items: [item("a", { fields: { summary: "S", ...fields } })] })?.roots[0]
      ?.fields;

  it("keeps every field but the summary, in request order, reading values without JSON", () => {
    expect(
      fieldsOf({
        description: "Synthetic",
        assignee: { name: "jdoe" },
        priority: { value: "High" },
        labels: ["a", "b"],
        storyPoints: 5,
        flagged: false,
        due: null,
        empty: [],
        blank: "",
      }),
    ).toEqual([
      { id: "description", value: { kind: "text", text: "Synthetic" } },
      { id: "assignee", value: { kind: "text", text: "jdoe" } },
      { id: "priority", value: { kind: "text", text: "High" } },
      {
        id: "labels",
        value: {
          kind: "list",
          items: [
            { position: 1, value: { kind: "text", text: "a" } },
            { position: 2, value: { kind: "text", text: "b" } },
          ],
        },
      },
      { id: "storyPoints", value: { kind: "text", text: "5" } },
      { id: "flagged", value: { kind: "text", text: "false" } },
      { id: "due", value: { kind: "cleared" } },
      { id: "empty", value: { kind: "empty" } },
      { id: "blank", value: { kind: "text", text: "" } },
    ]);
  });

  it("never hides a member: an object with more than one is shown as a named group, not JSON", () => {
    expect(fieldsOf({ assignee: { name: "jdoe", id: "7" }, nested: { custom: { a: 1 } } })).toEqual(
      [
        {
          id: "assignee",
          value: {
            kind: "group",
            members: [
              { name: "name", value: { kind: "text", text: "jdoe" } },
              { name: "id", value: { kind: "text", text: "7" } },
            ],
          },
        },
        {
          id: "nested",
          value: {
            kind: "group",
            members: [
              {
                name: "custom",
                value: {
                  kind: "group",
                  members: [{ name: "a", value: { kind: "text", text: "1" } }],
                },
              },
            ],
          },
        },
      ],
    );
  });

  it("names a value nested past the bound as not shown instead of dumping it", () => {
    let deep: unknown = { leaf: { deeper: 1 } };
    for (let level = 0; level < 8; level += 1) deep = { [`level${level}`]: deep, other: "x" };
    expect(JSON.stringify(fieldsOf({ deep }))).toContain('"kind":"hidden"');
  });

  it("carries the requirement references an item names", () => {
    expect(
      jiraDraftTree({ items: [item("a", { requirementIds: ["REQ-1", "REQ-2"] })] })?.roots[0]
        ?.requirementIds,
    ).toEqual(["REQ-1", "REQ-2"]);
  });
});

describe("jiraDraftExcluded", () => {
  it("extends a deselection to dependents through parents and links, ignoring unknown refs", () => {
    expect([...jiraDraftExcluded(DRAFT, new Set(["story", "ghost"]))].sort()).toEqual([
      "bug",
      "story",
      "sub",
    ]);
    expect(jiraDraftExcluded(DRAFT, new Set())).toEqual(new Set());
  });
});
