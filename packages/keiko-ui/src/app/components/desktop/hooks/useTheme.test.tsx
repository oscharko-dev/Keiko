import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts hydration-safe with dark and adopts a valid stored theme after mount", async () => {
    window.localStorage.setItem("keiko.theme", "light");

    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current.theme).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("keiko.theme")).toBe("light");
  });

  it("ignores invalid stored values and persists toggles", async () => {
    window.localStorage.setItem("keiko.theme", "sepia");

    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current.theme).toBe("dark"));
    act(() => result.current.toggle());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("keiko.theme")).toBe("light");
  });

  it("keeps the in-memory theme usable when localStorage writes fail", async () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage) as Storage, "setItem").mockImplementation(
      () => {
        throw new Error("quota");
      },
    );

    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current.theme).toBe("dark"));
    act(() => result.current.toggle());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps multiple mounted theme controls synchronized", async () => {
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());

    await waitFor(() => expect(first.result.current.theme).toBe("dark"));
    act(() => first.result.current.toggle());

    await waitFor(() => expect(second.result.current.theme).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("keiko.theme")).toBe("light");

    act(() => second.result.current.toggle());

    await waitFor(() => expect(first.result.current.theme).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("keiko.theme")).toBe("dark");

    act(() => {
      window.dispatchEvent(new CustomEvent("keiko:theme-change"));
      window.dispatchEvent(new CustomEvent("keiko:theme-change", { detail: "sepia" }));
    });

    expect(first.result.current.theme).toBe("dark");
    expect(second.result.current.theme).toBe("dark");
  });
});
