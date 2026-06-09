import { describe, expect, it } from "vitest";
import {
  firstSolidPaintHex,
  isVisiblePaint,
  paintColorToHex,
  parseHexRgb,
} from "../../domain/figma/color.js";
import type { FigmaSourceNode } from "../../domain/figma/sourceNode.js";

// Real Figma TEXT colour lives as an INLINE SOLID paint in `fills` (verified content-free against
// real boards, #838). These tests pin that the projection is correct AND that an invisible or
// fully-transparent paint is never reported as the colour.

const solid = (
  r: number,
  g: number,
  b: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "SOLID",
  color: { r, g, b, a: 1 },
  ...extra,
});

describe("paintColorToHex", () => {
  it("projects {r,g,b} 0..1 to #RRGGBB", () => {
    expect(paintColorToHex(solid(0, 0, 0))).toBe("#000000");
    expect(paintColorToHex(solid(1, 1, 1))).toBe("#ffffff");
  });

  it("appends alpha only when < 1", () => {
    expect(paintColorToHex({ color: { r: 1, g: 0, b: 0, a: 0.5 } })).toBe("#ff000080");
    expect(paintColorToHex({ color: { r: 1, g: 0, b: 0, a: 1 } })).toBe("#ff0000");
  });

  it("returns undefined for a paint with no colour", () => {
    expect(paintColorToHex({ type: "SOLID" })).toBeUndefined();
  });
});

describe("isVisiblePaint", () => {
  it("treats a paint as visible by default (Figma omits `visible` when shown)", () => {
    expect(isVisiblePaint(solid(0.1, 0.2, 0.3))).toBe(true);
  });

  it("rejects an explicitly hidden paint", () => {
    expect(isVisiblePaint(solid(0, 0, 0, { visible: false }))).toBe(false);
  });

  it("rejects a fully-transparent paint (opacity:0 or color.a:0)", () => {
    expect(isVisiblePaint(solid(0, 0, 0, { opacity: 0 }))).toBe(false);
    expect(isVisiblePaint({ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0 } })).toBe(false);
  });
});

describe("firstSolidPaintHex", () => {
  const withFills = (fills: unknown): FigmaSourceNode => ({ fills });

  it("returns the first visible SOLID paint's hex", () => {
    expect(firstSolidPaintHex(withFills([solid(1, 0, 0)]), "fills")).toBe("#ff0000");
  });

  it("skips a hidden SOLID and takes the next visible one", () => {
    const node = withFills([solid(0, 1, 0, { visible: false }), solid(0, 0, 1)]);
    expect(firstSolidPaintHex(node, "fills")).toBe("#0000ff");
  });

  it("skips a zero-opacity SOLID", () => {
    const node = withFills([solid(1, 1, 1, { opacity: 0 }), solid(0, 0, 0)]);
    expect(firstSolidPaintHex(node, "fills")).toBe("#000000");
  });

  it("ignores non-SOLID paints (gradients, images)", () => {
    const node = withFills([{ type: "GRADIENT_LINEAR" }, { type: "IMAGE", imageRef: "x" }]);
    expect(firstSolidPaintHex(node, "fills")).toBeUndefined();
  });

  it("returns undefined for an empty or absent fills array (→ coverage notice downstream)", () => {
    expect(firstSolidPaintHex(withFills([]), "fills")).toBeUndefined();
    expect(firstSolidPaintHex({}, "fills")).toBeUndefined();
  });
});

describe("parseHexRgb", () => {
  it("parses #RRGGBB into 0..255 channels", () => {
    expect(parseHexRgb("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
  });
  it("ignores a trailing alpha pair", () => {
    expect(parseHexRgb("#ff000080")).toEqual({ r: 255, g: 0, b: 0 });
  });
  it("returns undefined for a malformed value", () => {
    expect(parseHexRgb("not-a-hex")).toBeUndefined();
  });
});
