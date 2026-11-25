import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
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

// A region whose content height a test changes, as an answer that finishes loading does.
function growingRegion(clientHeight: number): {
  readonly element: HTMLDivElement;
  readonly grow: (height: number) => void;
} {
  const element = document.createElement("div");
  let scrollHeight = 1_000;
  let scrollTop = 0;
  Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(element, "clientHeight", { get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, scrollHeight - clientHeight));
    },
  });
  return {
    element,
    grow: (height: number): void => {
      scrollHeight = height;
    },
  };
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
    expect(fireEvent.keyDown(region, { key: "Home", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(region, { key: "End", metaKey: true })).toBe(true);
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

  it("says it paused while the reader is up the history and clears that on resume", () => {
    const region = fakeRegion(1720, 292);
    const { result } = renderFollow(region);
    expect(result.current.paused).toBe(false);
    region.scrollTop = 100;
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(true);
    act(() => {
      result.current.resume();
    });
    expect(result.current.paused).toBe(false);
  });

  it("clears the pause when the reader scrolls back near the bottom", () => {
    const region = fakeRegion(1720, 292);
    const { result } = renderFollow(region);
    region.scrollTop = 100;
    act(() => {
      result.current.onScroll();
    });
    region.scrollTop = 1720 - 292;
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(false);
  });

  it("pauses on Home and resumes on End, the keys a keyboard reader uses", () => {
    const seen: boolean[] = [];
    function Probe(): ReactNode {
      const ref = useRef<HTMLDivElement>(null);
      const follow = useFollowNewest(ref, "a");
      seen.push(follow.paused);
      return createElement("div", { ref: follow.regionRef, role: "log", tabIndex: 0 });
    }
    const view = render(createElement(Probe));
    const region = view.getByRole("log");
    Object.defineProperty(region, "scrollTo", { value: (): void => undefined });
    fireEvent.keyDown(region, { key: "Home" });
    expect(seen.at(-1)).toBe(true);
    fireEvent.keyDown(region, { key: "End" });
    expect(seen.at(-1)).toBe(false);
  });

  it("does nothing without a region", () => {
    const { result } = renderHook(() => useFollowNewest(useRef<HTMLElement | null>(null), "a"));
    expect(() => {
      result.current.onScroll();
      result.current.resume();
    }).not.toThrow();
  });

  it("turns scroll anchoring off while it follows and back on while the reader is paused", () => {
    const region = fakeRegion(1_000, 300);
    function Region(): ReactNode {
      const ref = useRef<HTMLElement | null>(null);
      const { regionRef, onScroll } = useFollowNewest(ref, "a");
      useLayoutEffect(() => {
        regionRef(region);
      }, [regionRef]);
      return createElement("button", { type: "button", onClick: onScroll }, "scrolled");
    }
    const view = render(createElement(Region));
    // A following region: the browser must not move it when a row above opens itself.
    expect(region.style.getPropertyValue("overflow-anchor")).toBe("none");
    region.scrollTop = 100;
    fireEvent.click(view.getByRole("button"));
    // A reader in the history keeps the rows they read in place.
    expect(region.style.getPropertyValue("overflow-anchor")).toBe("auto");
    region.scrollTop = 700;
    fireEvent.click(view.getByRole("button"));
    expect(region.style.getPropertyValue("overflow-anchor")).toBe("none");
  });

  it("keeps following when content grows after its own scroll to the end", () => {
    const { element, grow } = growingRegion(300);
    const { result } = renderFollow(element);
    expect(element.scrollTop).toBe(700);
    // The answer finished loading after the scroll to the end; its scroll event arrives later, at
    // the position the region itself set.
    grow(1_600);
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(false);
    expect(element.scrollTop).toBe(1_300);
  });

  it("pauses when the reader scrolls up after content grew", () => {
    const { element, grow } = growingRegion(300);
    const { result } = renderFollow(element);
    grow(1_600);
    element.scrollTop = 650;
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(true);
    expect(element.scrollTop).toBe(650);
    grow(2_000);
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(true);
    expect(element.scrollTop).toBe(650);
  });

  it("goes to the end again when content changes without a scroll of its own", async () => {
    const { element, grow } = growingRegion(300);
    function Region(): ReactNode {
      const ref = useRef<HTMLElement | null>(null);
      const { regionRef } = useFollowNewest(ref, "a");
      useLayoutEffect(() => {
        regionRef(element);
      }, [regionRef]);
      return null;
    }
    render(createElement(Region));
    expect(element.scrollTop).toBe(700);
    grow(1_600);
    element.append(document.createElement("p"));
    await waitFor(() => {
      expect(element.scrollTop).toBe(1_300);
    });
  });

  it("lets a reader leave the end with a slow scroll in steps of less than a pixel", () => {
    const { element } = growingRegion(300);
    const { result } = renderFollow(element);
    const yanked: number[] = [];
    for (let top = 699.5; top >= 635; top -= 0.5) {
      element.scrollTop = top;
      act(() => {
        result.current.onScroll();
      });
      if (element.scrollTop !== top) yanked.push(top);
    }
    expect(yanked).toEqual([]);
    expect(result.current.paused).toBe(true);
    expect(element.scrollTop).toBe(635);
  });

  it("does not bring a paused region to its end on a scroll event at an unchanged position", () => {
    const { element, grow } = growingRegion(300);
    const { result } = renderFollow(element);
    element.scrollTop = 100;
    act(() => {
      result.current.onScroll();
    });
    grow(1_600);
    act(() => {
      result.current.onScroll();
    });
    expect(result.current.paused).toBe(true);
    expect(element.scrollTop).toBe(100);
  });

  it("follows growth again after resume", async () => {
    const { element, grow } = growingRegion(300);
    const { result } = renderBound(element);
    element.scrollTop = 100;
    act(() => {
      result.current.onScroll();
    });
    act(() => {
      result.current.resume();
    });
    expect(element.scrollTop).toBe(700);
    grow(1_600);
    element.append(document.createElement("p"));
    await waitFor(() => {
      expect(element.scrollTop).toBe(1_300);
    });
  });

  it("leaves a row the reader opened where it is", async () => {
    const { element, grow } = growingRegion(300);
    const { result, rerender } = renderBound(element);
    // The reader clicks a row; the rows it opens are theirs to read, not newest content.
    fireEvent.pointerDown(element);
    grow(1_600);
    element.append(document.createElement("p"));
    await Promise.resolve();
    expect(element.scrollTop).toBe(700);
    expect(result.current.paused).toBe(false);
    // The next growth of the content follows again.
    rerender({ key: "b" });
    expect(element.scrollTop).toBe(1_300);
  });

  it("binds a region where no MutationObserver exists", () => {
    vi.stubGlobal("MutationObserver", undefined);
    try {
      const { element } = growingRegion(300);
      const { result, unmount } = renderBound(element);
      expect(element.scrollTop).toBe(700);
      expect(result.current.paused).toBe(false);
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The hook with its region bound as a component binds it, so its observer and listeners run.
function renderBound(
  element: HTMLElement,
): ReturnType<typeof renderHook<ReturnType<typeof useFollowNewest>, { key: string }>> {
  return renderHook(
    ({ key }: { key: string }) => {
      const follow = useFollowNewest(useRef<HTMLElement | null>(null), key);
      const { regionRef } = follow;
      useLayoutEffect(() => {
        regionRef(element);
      }, [regionRef]);
      return follow;
    },
    { initialProps: { key: "a" } },
  );
}
