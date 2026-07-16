import { describe, expect, it } from "vitest";

import {
  BLAME_GLYPH_MARGIN_LANE,
  DEBUG_GLYPH_MARGIN_LANE,
  GIT_GUTTER_GLYPH_MARGIN_LANE,
} from "./glyph-margin-lanes.js";

describe("glyph margin lane assignment", () => {
  it("gives the debug, git-gutter, and blame decoration kinds three distinct lanes", () => {
    const lanes = new Set([
      DEBUG_GLYPH_MARGIN_LANE,
      GIT_GUTTER_GLYPH_MARGIN_LANE,
      BLAME_GLYPH_MARGIN_LANE,
    ]);
    expect(lanes.size).toBe(3);
  });

  it("only ever uses Monaco's three valid GlyphMarginLane values (Left=1, Center=2, Right=3)", () => {
    for (const lane of [
      DEBUG_GLYPH_MARGIN_LANE,
      GIT_GUTTER_GLYPH_MARGIN_LANE,
      BLAME_GLYPH_MARGIN_LANE,
    ]) {
      expect([1, 2, 3]).toContain(lane);
    }
  });
});
