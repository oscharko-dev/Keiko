import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEditorThemeVariant, useEditorThemeVariant } from "./useEditorThemeVariant";

function setHighContrast(active: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: active && (query.includes("prefers-contrast") || query.includes("forced-colors")),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  setHighContrast(false);
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  setHighContrast(false);
});

describe("readEditorThemeVariant", () => {
  it("defaults to dark when no theme is set", () => {
    expect(readEditorThemeVariant()).toBe("dark");
  });

  it("returns light when the app theme is light", () => {
    document.documentElement.dataset.theme = "light";
    expect(readEditorThemeVariant()).toBe("light");
  });

  it("escalates to high-contrast in dark mode when more contrast is preferred", () => {
    document.documentElement.dataset.theme = "dark";
    setHighContrast(true);
    expect(readEditorThemeVariant()).toBe("high-contrast");
  });

  it("keeps the light variant under high contrast (no dedicated light hc base)", () => {
    document.documentElement.dataset.theme = "light";
    setHighContrast(true);
    expect(readEditorThemeVariant()).toBe("light");
  });
});

describe("useEditorThemeVariant", () => {
  it("adopts the current theme on mount and follows live data-theme changes", async () => {
    document.documentElement.dataset.theme = "light";
    const { result } = renderHook(() => useEditorThemeVariant());
    await waitFor(() => {
      expect(result.current).toBe("light");
    });
    act(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await waitFor(() => {
      expect(result.current).toBe("dark");
    });
  });
});
