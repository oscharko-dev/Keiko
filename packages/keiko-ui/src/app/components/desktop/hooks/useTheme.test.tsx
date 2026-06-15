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
});
