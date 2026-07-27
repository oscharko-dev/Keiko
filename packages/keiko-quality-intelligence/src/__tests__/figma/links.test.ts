// Unit tests for the deterministic link-key comparator used to sort raw inter-screen links
// (Epic #750, Issue #752). Pure, standalone helper — covered directly rather than indirectly
// through extractInterScreenLinks, since the Map-based de-dup upstream guarantees distinct keys
// reach `.sort()`, so the "equal" branch can only be exercised by calling the comparator itself.

import { describe, expect, it } from "vitest";

import { compareLinkKey } from "../../domain/figma/links.js";

describe("compareLinkKey", () => {
  it("returns -1 when the left value sorts before the right value", () => {
    expect(compareLinkKey("a", "b")).toBe(-1);
  });

  it("returns 1 when the left value sorts after the right value", () => {
    expect(compareLinkKey("b", "a")).toBe(1);
  });

  it("returns 0 for equal values", () => {
    expect(compareLinkKey("a", "a")).toBe(0);
  });
});
