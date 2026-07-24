import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("editor M11 browser closeout source contract (#2533)", () => {
  it("uses real product routes and retains mixed-trust, profile, history, axe, and visual proof", () => {
    const spec = readFileSync("tests/e2e/editor-m11-closeout-2533.spec.ts", "utf8");
    expect(spec).not.toContain("page.route(");
    expect(spec).toContain("/api/workspaces");
    expect(spec).toContain("/api/editor/verification/trust");
    expect(spec).toContain("Current profile: Focused M11");
    expect(spec).toContain("Open file history");
    expect(spec).toContain("Restore version");
    expect(spec).toContain("runAxe");
    expect(spec).toContain("MULTI_ROOT_ARIA_FINDING = 2605");
    expect(spec).toContain("editor-m11-closeout.png");
    expect(spec).toContain("FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET");
  });
});
