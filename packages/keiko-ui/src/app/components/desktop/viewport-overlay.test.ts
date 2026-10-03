import { describe, expect, it } from "vitest";
import { viewportOverlayPosition } from "./viewport-overlay";

describe("viewport overlay geometry", () => {
  it.each([
    { left: -50, top: 300, bottom: 332 },
    { left: 390, top: 300, bottom: 332 },
    { left: 100, top: 8, bottom: 40 },
    { left: 100, top: 600, bottom: 632 },
  ])("keeps a tall overlay inside a narrow viewport for anchor %j", (anchor) => {
    const result = viewportOverlayPosition({
      anchor,
      width: 500,
      height: 600,
      viewportWidth: 420,
      viewportHeight: 360,
      gap: 8,
      preferUp: true,
    });
    expect(result.left).toBeGreaterThanOrEqual(16);
    expect(result.top).toBeGreaterThanOrEqual(16);
    expect(result.left + result.width).toBeLessThanOrEqual(404);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(344);
  });

  it("opens above a bottom composer and falls below a top anchor", () => {
    const input = {
      width: 300,
      height: 450,
      viewportWidth: 1100,
      viewportHeight: 700,
      gap: 6,
      preferUp: false,
    };
    expect(
      viewportOverlayPosition({ ...input, anchor: { left: 50, top: 620, bottom: 660 } }).openUp,
    ).toBe(true);
    expect(
      viewportOverlayPosition({ ...input, anchor: { left: 50, top: 30, bottom: 70 } }).openUp,
    ).toBe(false);
  });
});
