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
    expect(epic?.children[0]?.children[0]).toMatchObject({ ref: "sub", otherFieldCount: 1 });
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
