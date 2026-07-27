import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SPEC = "tests/e2e/editor-m11-closeout-2533.spec.ts";

describe("editor M11 browser closeout source contract (#2533)", () => {
  it("uses real product routes and retains mixed-trust, profile, history, axe, and visual proof", () => {
    const spec = readFileSync(SPEC, "utf8");
    expect(spec).not.toContain("page.route(");
    expect(spec).toContain("/api/workspaces");
    expect(spec).toContain("/api/editor/verification/trust");
    expect(spec).toContain("Current profile: Focused M11");
    expect(spec).toContain("Open file history");
    expect(spec).toContain("Restore version");
    expect(spec).toContain("runAxe");
    // #2605 is fixed, so the Explorer is held to the same zero-violation bar as the other two
    // surfaces. The guard pins the green assertion AND forbids the shapes that would quietly
    // re-admit a violation: a tolerated "known finding" or a disabled/excluded rule.
    expect(spec).toContain('await expectAxeGreen(journeyPage, "[data-multi-root-explorer]");');
    expect(spec).not.toContain("expectKnownMultiRootAxeFinding");
    expect(spec).not.toContain("aria-required-children");
    expect(spec).toContain("editor-m11-closeout.png");
    expect(spec).toContain("FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET");
  });

  // Both repairs of #2626 are about WHICH surface and WHICH sinks the journey inspects, and both
  // are the kind of thing a refactor silently undoes: the settings window reverts to its default
  // Models tab whenever the page is replaced, and a storage probe narrowed back to localStorage
  // still passes. Pin the two call sites so the scanned surface and the probed sinks cannot drift
  // away from what the closeout documents claim.
  it("scans the profile settings surface and probes every browser storage sink", () => {
    const spec = readFileSync(SPEC, "utf8");
    expect(spec).toContain("await openProfileSettingsSurface(journeyPage);");
    expect(spec).toContain('settings.getByRole("button", { name: "Editor" })');
    expect(spec).toContain('settings.getByRole("combobox", { name: "Profile" })');
    expect(spec).toContain("storageState({ indexedDB: true })");
    // Read through the documented API, never by serializing the `Storage` object: whether named
    // properties are own-enumerable is an engine detail, and the probe must not rest on it.
    expect(spec).toContain("window.sessionStorage.key(index)");
    expect(spec).not.toContain("JSON.stringify(window.sessionStorage)");
    expect(spec).toContain("const storage = await browserStorageDump(journeyPage);");
    expect(spec).toContain('storage.includes("keiko.workspace.v4")');
    expect(spec).toContain('storage.includes("session-sink-reachable")');
    expect(spec).toContain('storage.includes("historyValue")');
    // The dump is never the subject of a matcher: a failing `toContain` prints what it searched,
    // which here is every browser sink — the failure report would leak what the test proves absent.
    expect(spec).not.toContain("expect(storage).toContain");
    expect(spec).not.toContain("expect(storage).not.toContain");
  });
});
