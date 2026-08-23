import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useFollowNewest } from "./useFollowNewest";

function fakeRegion(scrollHeight: number, clientHeight: number): HTMLDivElement {
  const element = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(element, "clientHeight", { get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
    },
  });
  return element;
}

function renderFollow(
  region: HTMLElement,
): ReturnType<typeof renderHook<ReturnType<typeof useFollowNewest>, { key: string }>> {
  return renderHook(
    ({ key }: { key: string }) => useFollowNewest(useRef<HTMLElement | null>(region), key),
    { initialProps: { key: "a" } },
  );
}

describe("useFollowNewest", () => {
  it("scrolls to the end on mount and on every growth while the reader is at the bottom", () => {
    const region = fakeRegion(1720, 292);
    const { rerender } = renderFollow(region);
    expect(region.scrollTop).toBe(1720);
    region.scrollTop = 1700;
    rerender({ key: "b" });
    expect(region.scrollTop).toBe(1720);
  });

  it("stops following once the reader scrolls up into the history", () => {
    const region = fakeRegion(1720, 292);
    const { result, rerender } = renderFollow(region);
    region.scrollTop = 100;
    result.current.onScroll();
    rerender({ key: "b" });
    expect(region.scrollTop).toBe(100);
  });

  it("follows again when the reader returns near the bottom", () => {
    const region = fakeRegion(1720, 292);
    const { result, rerender } = renderFollow(region);
    region.scrollTop = 100;
    result.current.onScroll();
    region.scrollTop = 1720 - 292 - 10;
    result.current.onScroll();
    rerender({ key: "b" });
    expect(region.scrollTop).toBe(1720);
  });

  it("resumes on request regardless of the current position", () => {
    const region = fakeRegion(1720, 292);
    const { result } = renderFollow(region);
    region.scrollTop = 100;
    result.current.onScroll();
    result.current.resume();
    expect(region.scrollTop).toBe(1720);
  });

  it("does nothing without a region", () => {
    const { result } = renderHook(() => useFollowNewest(useRef<HTMLElement | null>(null), "a"));
    expect(() => {
      result.current.onScroll();
      result.current.resume();
    }).not.toThrow();
  });
});
