import { fireEvent, render, renderHook } from "@testing-library/react";
import { createElement, useLayoutEffect, useRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFollowNewest } from "./useFollowNewest";
import { reportClientDiagnostic } from "./client-diagnostics";

vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

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
  Object.defineProperty(element, "scrollTo", {
    value: ({ top }: { readonly top: number }): void => {
      scrollTop = top;
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

function KeyboardRegion({ growthKey }: { readonly growthKey: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useFollowNewest(ref, growthKey);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    const geometry = fakeRegion(1720, 292);
    for (const property of ["scrollHeight", "clientHeight", "scrollTop", "scrollTo"]) {
      const descriptor = Object.getOwnPropertyDescriptor(geometry, property);
      if (descriptor !== undefined) Object.defineProperty(ref.current, property, descriptor);
    }
  }, []);
  return createElement(
    "div",
    { ref: follow.regionRef, role: "log", onScroll: follow.onScroll },
    createElement("input", { "aria-label": "Nested input" }),
  );
}

describe("useFollowNewest", () => {
  it("honours Home before a native scroll event and keeps later growth at the chosen start", () => {
    const view = render(createElement(KeyboardRegion, { growthKey: "a" }));
    const region = view.getByRole("log");
    expect(region.scrollTop).toBe(1720);
    fireEvent.keyDown(region, { key: "Home" });
    expect(region.scrollTop).toBe(0);
    view.rerender(createElement(KeyboardRegion, { growthKey: "b" }));
    expect(region.scrollTop).toBe(0);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Transcript navigation settled.",
      expect.objectContaining({
        stageReport: {
          stage: "transcript navigation",
          phase: "settled",
          ordinal: 1,
          durationMs: 0,
        },
      }),
    );
  });

  it("resumes following with End without waiting for a native scroll event", () => {
    const view = render(createElement(KeyboardRegion, { growthKey: "a" }));
    const region = view.getByRole("log");
    fireEvent.keyDown(region, { key: "Home" });
    fireEvent.keyDown(region, { key: "End" });
    expect(region.scrollTop).toBe(1720);
    region.scrollTop = 1700;
    view.rerender(createElement(KeyboardRegion, { growthKey: "b" }));
    expect(region.scrollTop).toBe(1720);
  });

  it("preserves nested inputs, selection gestures, composition and unrelated keys", () => {
    const view = render(createElement(KeyboardRegion, { growthKey: "a" }));
    const region = view.getByRole("log");
    fireEvent.keyDown(view.getByRole("textbox"), { key: "Home" });
    fireEvent.keyDown(region, { key: "Home", shiftKey: true });
    fireEvent.keyDown(region, { key: "Home", altKey: true });
    fireEvent.keyDown(region, { key: "Home", isComposing: true });
    fireEvent.keyDown(region, { key: "ArrowUp" });
    expect(region.scrollTop).toBe(1720);
  });

  it("removes native navigation when the log unmounts", () => {
    const view = render(createElement(KeyboardRegion, { growthKey: "a" }));
    const region = view.getByRole("log");
    view.unmount();
    region.scrollTop = 100;
    fireEvent.keyDown(region, { key: "End" });
    expect(region.scrollTop).toBe(100);
  });

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

  it("still follows at exactly the near-bottom boundary", () => {
    const region = fakeRegion(1720, 292);
    const { result, rerender } = renderFollow(region);
    region.scrollTop = 1720 - 292 - 64;
    result.current.onScroll();
    rerender({ key: "b" });
    expect(region.scrollTop).toBe(1720);
  });

  it("stops following one pixel beyond the near-bottom boundary", () => {
    const region = fakeRegion(1720, 292);
    const { result, rerender } = renderFollow(region);
    region.scrollTop = 1720 - 292 - 65;
    result.current.onScroll();
    rerender({ key: "b" });
    expect(region.scrollTop).toBe(1720 - 292 - 65);
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
