import { describe, expect, it } from "vitest";
import { planRuntimeOverrides } from "../lib/runtime-override-projection.mjs";

describe("reviewed runtime override ancestors", () => {
  it("includes a peer-coupled plugin in the same delivered parser family", () => {
    const packages = new Map([
      [
        "node_modules/parent",
        { version: "1.0.0", dependencies: { parser: "1.0.0", plugin: "1.0.0" } },
      ],
      ["node_modules/parser", { version: "1.0.0", dependencies: { leaf: "1.0.0" } }],
      ["node_modules/plugin", { version: "1.0.0", peerDependencies: { parser: "^1.0.0" } }],
      ["node_modules/leaf", { version: "2.0.0" }],
    ]);
    const plan = planRuntimeOverrides(
      packages,
      [{ name: "parent", range: "1.0.0", optional: false, origins: [""] }],
      { leaf: "2.0.0" },
    );
    expect(plan.ancestors.map((entry) => entry.name).sort()).toEqual([
      "parent",
      "parser",
      "plugin",
    ]);
    expect(plan.ancestors.every((entry) => !entry.optional)).toBe(true);
    expect(Object.fromEntries(plan.pins)).toEqual({ leaf: "2.0.0" });
  });
});
