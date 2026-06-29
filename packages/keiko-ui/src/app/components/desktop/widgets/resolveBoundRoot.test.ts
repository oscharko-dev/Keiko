// Unit coverage for the single bound-surface root choke point (Issue #446, ADR-0090 D4). Proves the
// override precedence that every bound surface (files/editor/terminal/commands/runtime/container/
// git-delivery) relies on: an active workspace root wins over the per-window cfg and the linked-window
// fallback (AC1/AC2, SC1/SC3); in unbound mode the legacy cfg → linkedRoot chain is preserved.

import { describe, expect, it } from "vitest";
import { resolveBoundRoot } from "./index";

describe("resolveBoundRoot", () => {
  it("returns the active root when a workspace is active, overriding cfg and linkedRoot", () => {
    expect(resolveBoundRoot({ activeRoot: "/wt/a", linkedRoot: "/repo" }, "/cfg")).toBe("/wt/a");
  });

  it("falls back to the cfg root in unbound mode", () => {
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: "/repo" }, "/cfg")).toBe("/cfg");
  });

  it("falls back to the linked-window root when unbound and cfg is absent", () => {
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: "/repo" }, undefined)).toBe("/repo");
  });

  it("returns undefined when nothing is bound, configured, or linked", () => {
    expect(resolveBoundRoot({ activeRoot: null, linkedRoot: null }, undefined)).toBeUndefined();
  });

  it("a switch (active root change) deterministically re-points away from the old cfg root", () => {
    const cfgRoot = "/cfg";
    expect(resolveBoundRoot({ activeRoot: "/wt/a", linkedRoot: null }, cfgRoot)).toBe("/wt/a");
    // After switching to workspace B, the SAME cfg resolves to B's root — no stale context survives.
    expect(resolveBoundRoot({ activeRoot: "/wt/b", linkedRoot: null }, cfgRoot)).toBe("/wt/b");
  });
});
