import { describe, expect, it } from "vitest";
import {
  EDITOR_SIDEBAR_DEFAULT_WIDTH,
  EDITOR_SIDEBAR_MIN_WIDTH,
  EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
  editorSidebarBounds,
  editorSidebarTrackWidth,
  editorSidebarWidthFromPointer,
} from "./editorSidebarSizing";

describe("editor sidebar sizing", () => {
  it("allows an IDE-like range from a narrow rail to almost the full workspace", () => {
    expect(editorSidebarBounds(1_000)).toEqual({
      min: EDITOR_SIDEBAR_MIN_WIDTH,
      max: 950,
    });
    expect(EDITOR_SIDEBAR_MIN_WIDTH).toBeLessThanOrEqual(50);
    expect(EDITOR_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(EDITOR_SIDEBAR_MIN_WIDTH);
    expect(EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH).toBeGreaterThan(4_000);
  });

  it("keeps a usable editor remainder in a narrow workspace", () => {
    expect(editorSidebarBounds(320)).toEqual({
      min: EDITOR_SIDEBAR_MIN_WIDTH,
      max: 272,
    });
  });

  it("emits a responsive track that clamps wide persisted values after a window shrink", () => {
    expect(editorSidebarTrackWidth(2_400)).toBe("max(48px, min(2400px, 95%, calc(100% - 48px)))");
    expect(editorSidebarTrackWidth(Number.MAX_SAFE_INTEGER)).toContain("min(32768px");
  });

  it("converts transformed screen coordinates back to logical workspace pixels", () => {
    expect(
      editorSidebarWidthFromPointer({
        clientX: 550,
        rectLeft: 100,
        rectWidth: 500,
        logicalWorkspaceWidth: 1_000,
      }),
    ).toBe(900);
  });

  it("clamps pointer positions at both live bounds", () => {
    const input = {
      rectLeft: 100,
      rectWidth: 500,
      logicalWorkspaceWidth: 1_000,
    };
    expect(editorSidebarWidthFromPointer({ ...input, clientX: 110 })).toBe(
      EDITOR_SIDEBAR_MIN_WIDTH,
    );
    expect(editorSidebarWidthFromPointer({ ...input, clientX: 600 })).toBe(950);
  });
});
