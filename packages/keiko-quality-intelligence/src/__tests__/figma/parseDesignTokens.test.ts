import { describe, expect, it } from "vitest";
import { parseDesignTokens } from "../../domain/figma/tokens.js";
import { extractDesignTokens } from "../../domain/figma/tokens.js";
import type { PrunedNode } from "../../domain/figma/prune.js";

// parseDesignTokens re-hydrates the opaque, persisted design-tokens artifact (#752) for design-to-code
// (#755), which reads the STORED snapshot. It must round-trip extractDesignTokens output and degrade
// defensively on malformed/old data — synthetic fixtures only, never customer content.

describe("parseDesignTokens", () => {
  it("returns an empty token set for a non-object / missing value", () => {
    for (const value of [undefined, null, 42, "x", []]) {
      expect(parseDesignTokens(value)).toEqual({
        colors: [],
        typography: [],
        spacing: [],
        radius: [],
      });
    }
  });

  it("round-trips an extracted tokens artifact (serialise → parse is identity)", () => {
    const pruned: PrunedNode = {
      source: {
        type: "TEXT",
        characters: "Hi",
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
        style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24 },
        cornerRadius: 8,
        itemSpacing: 12,
      },
      children: [],
    };
    const extracted = extractDesignTokens([pruned]);
    // Serialise (as the snapshot persists) then parse back.
    const reparsed = parseDesignTokens(JSON.parse(JSON.stringify(extracted)));
    expect(reparsed).toEqual(extracted);
    expect(reparsed.colors.length).toBeGreaterThan(0);
    expect(reparsed.typography.length).toBe(1);
    expect(reparsed.spacing.length).toBeGreaterThan(0);
    expect(reparsed.radius.length).toBe(1);
  });

  it("drops malformed rows in a family rather than crashing", () => {
    const parsed = parseDesignTokens({
      colors: [{ value: "#ffffff" }, { value: 123 }, "nope", null],
      typography: [
        { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 24 },
        { fontFamily: "X" },
      ],
      spacing: [{ value: 8 }, { value: "8" }],
      radius: "not-an-array",
    });
    expect(parsed.colors).toEqual([{ id: "color:#ffffff", kind: "color", value: "#ffffff" }]);
    expect(parsed.typography).toHaveLength(1);
    expect(parsed.spacing).toEqual([{ id: "spacing:8", kind: "spacing", value: 8 }]);
    expect(parsed.radius).toEqual([]);
  });
});
