// GEN-MAINT-COMPLEXITY-001 — unit coverage for the pure tab-viewport geometry extracted from
// EditorRuntimeWidget. Pure functions of primitive/array args; no DOM, so this runs under node/jsdom.

import { describe, expect, it } from "vitest";
import { readableTabCapacity, visibleTabsForCapacity } from "./editorTabViewport";

describe("readableTabCapacity", () => {
  it("shows every tab when there are two or fewer regardless of width", () => {
    expect(readableTabCapacity(0, 0)).toBe(0);
    expect(readableTabCapacity(10, 1)).toBe(1);
    expect(readableTabCapacity(10, 2)).toBe(2);
  });

  it("shows every tab when the tablist is not measured yet", () => {
    expect(readableTabCapacity(0, 5)).toBe(5);
    expect(readableTabCapacity(-100, 5)).toBe(5);
  });

  it("shows every tab when the full row fits at the readable tile width", () => {
    // 5 tabs * 112px tile = 560px; a 560px (or wider) tablist fits all of them.
    expect(readableTabCapacity(560, 5)).toBe(5);
    expect(readableTabCapacity(9999, 5)).toBe(5);
  });

  it("reserves room for the summary trigger and clamps to tabCount - 1 when overflowing", () => {
    // 400px - 58px summary = 342px usable; floor(342 / 112) = 3 visible, leaving a summary menu.
    expect(readableTabCapacity(400, 8)).toBe(3);
  });

  it("never returns fewer than one visible tab", () => {
    // A very narrow tablist still keeps at least one readable tab.
    expect(readableTabCapacity(60, 8)).toBe(1);
  });
});

describe("visibleTabsForCapacity", () => {
  const tabs = ["a", "b", "c", "d", "e"] as const;

  it("returns the full list when capacity covers every tab", () => {
    expect(visibleTabsForCapacity(tabs, 0, 5)).toEqual(tabs);
    expect(visibleTabsForCapacity(tabs, 3, 10)).toEqual(tabs);
  });

  it("returns the requested window when capacity is smaller than the list", () => {
    expect(visibleTabsForCapacity(tabs, 1, 2)).toEqual(["b", "c"]);
  });

  it("clamps the start index so the window never runs off the end", () => {
    // start 4 with capacity 3 would overrun; it clamps to the last full window.
    expect(visibleTabsForCapacity(tabs, 4, 3)).toEqual(["c", "d", "e"]);
  });

  it("clamps a negative start index to zero", () => {
    expect(visibleTabsForCapacity(tabs, -2, 2)).toEqual(["a", "b"]);
  });
});
