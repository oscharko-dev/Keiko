import { describe, expect, it } from "vitest";
import { childRegistrationSet, CHILD_WORKSPACE_READ_ALIAS } from "./child.js";
import { createKeikoToolCatalog } from "./composer.js";
import { compileToolProjection } from "./projection.js";
import { createInitialToolCatalog } from "./legacy.js";

describe("child registration set", () => {
  it("declares exactly one read-only tool under the reserved child.workspace.read identity", () => {
    const catalog = createKeikoToolCatalog([childRegistrationSet()]);
    const projection = compileToolProjection(catalog, { id: "child", version: 1 });
    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.toolRef).toEqual({
      canonicalId: "keiko.child.workspace.read",
      contractVersion: 1,
    });
    expect(projection.tools[0]?.alias).toBe(CHILD_WORKSPACE_READ_ALIAS);
    expect(projection.tools[0]?.idempotency).toBe("read-only");
  });

  it("never reuses the legacy read_file alias", () => {
    const catalog = createKeikoToolCatalog([childRegistrationSet()]);
    const projection = compileToolProjection(catalog, { id: "child", version: 1 });
    expect(projection.tools.some((tool) => tool.alias === "read_file")).toBe(false);
  });

  it("does not change what createInitialToolCatalog() produces", () => {
    // createInitialToolCatalog() composes only the legacy-native set; adding a child set exists
    // as a separate catalog, never mutating this one (AGENTS.md §7: no restated formula).
    const before = createInitialToolCatalog();
    expect(createInitialToolCatalog()).toEqual(before);
    expect(before.profiles).toHaveLength(1);
    expect(before.profiles[0]?.profile.id).toBe("legacy-native");
  });
});
