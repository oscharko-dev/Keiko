// The shell-level error boundary. Before it existed, a render-time throw anywhere in AppShellInner
// propagated out of the root with no boundary above it and React unmounted the desktop to a blank
// page — and when the throw came from a persisted keybinding override, it came back on every load
// with no in-product affordance at all. These tests assert the blank page is now an actionable
// surface, and that the boundary sits in the shell's real provider frame (AppShellFrame).

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShellFrame } from "./AppShell";
import { AppShellBoundary } from "./AppShellBoundary";
import { I18nProvider } from "@/lib/i18n";

// Silences React's expected error-boundary console noise for a render that throws.
function withBoundaryNoise<T>(message: string, run: () => T): T {
  const onError = (event: ErrorEvent): void => {
    const text = event.error instanceof Error ? event.error.message : event.message;
    if (text.includes(message)) event.preventDefault();
  };
  window.addEventListener("error", onError);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return run();
  } finally {
    errorSpy.mockRestore();
    window.removeEventListener("error", onError);
  }
}

// Declared once so the leak assertion below checks the exact text this suite throws, rather than a
// second copy that could drift away from it and pass vacuously.
const BOUNDARY_THROW_MESSAGE = "forced shell defect";

function Bomb({ armed }: { readonly armed: boolean }): ReactNode {
  if (armed) throw new Error(BOUNDARY_THROW_MESSAGE);
  return <div>desktop rendered</div>;
}

function renderBoundary(
  children: ReactNode,
  props: Partial<Parameters<typeof AppShellBoundary>[0]>,
): RenderResult & { readonly warnSpy: ReturnType<typeof vi.spyOn> } {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const result = withBoundaryNoise("forced shell defect", () =>
    render(
      <I18nProvider>
        <AppShellBoundary {...props}>{children}</AppShellBoundary>
      </I18nProvider>,
    ),
  );
  return { ...result, warnSpy };
}

describe("AppShellBoundary", () => {
  // Most cases below assert the ENGLISH recovery copy and one deliberately asserts the German, so
  // the language is part of what is under test and belongs next to the assertion rather than
  // inherited from jsdom's navigator or from whichever test ran last. The shared teardown clears
  // the key after every test (AGENTS.md §7: no shared mutable global state); this states the
  // precondition where a reader checking the expected string can see it.
  beforeEach(() => {
    window.localStorage.setItem("keiko.locale", "en");
  });

  it("renders a healthy shell untouched", () => {
    render(
      <I18nProvider>
        <AppShellBoundary>
          <Bomb armed={false} />
        </AppShellBoundary>
      </I18nProvider>,
    );

    expect(screen.getByText("desktop rendered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("degrades a render-time throw to an actionable surface instead of a blank page", () => {
    const { warnSpy } = renderBoundary(<Bomb armed />, {});
    try {
      const alert = screen.getByRole("alert");

      expect(alert.textContent).toContain("Keiko could not open the workspace");
      expect(alert.textContent).toContain("failed while rendering");
      expect(alert.textContent).toContain("saved keyboard shortcut override");
      expect(
        screen.getByRole("button", { name: /Reset saved shortcuts and reload/u }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /Reload Keiko/u })).toBeTruthy();
      // 0.3.0 audit (Qodo review on #2869): the boundary reports the error's CLASS and nothing else.
      // Strengthened from asserting the old shape — a raw Error carries a stack with absolute paths
      // and a message Keiko does not control, and the console is the surface users screenshot into
      // bug reports. Both directions are pinned: the class is present, the object is not.
      expect(warnSpy).toHaveBeenCalledWith("[keiko] app shell crashed: Error");
      for (const call of warnSpy.mock.calls) {
        for (const argument of call) {
          expect(argument).not.toBeInstanceOf(Error);
          expect(String(argument)).not.toContain(BOUNDARY_THROW_MESSAGE);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resets the offending persisted state and reloads when the user recovers", async () => {
    const resetPersistedState = vi.fn(async () => undefined);
    const reload = vi.fn();
    const { warnSpy } = renderBoundary(<Bomb armed />, { resetPersistedState, reload });
    try {
      fireEvent.click(screen.getByRole("button", { name: /Reset saved shortcuts and reload/u }));

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(resetPersistedState).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("says the reset failed rather than reloading into the same broken state", async () => {
    const resetPersistedState = vi.fn(() => Promise.reject(new Error("reset refused")));
    const reload = vi.fn();
    const { warnSpy } = renderBoundary(<Bomb armed />, { resetPersistedState, reload });
    try {
      fireEvent.click(screen.getByRole("button", { name: /Reset saved shortcuts and reload/u }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "saved shortcuts could not be reset",
        ),
      );
      expect(reload).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reloads on the plain reload action", () => {
    const reload = vi.fn();
    const { warnSpy } = renderBoundary(<Bomb armed />, { reload });
    try {
      fireEvent.click(screen.getByRole("button", { name: /Reload Keiko/u }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("translates the recovery surface into the active locale", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      withBoundaryNoise("forced shell defect", () =>
        render(
          <I18nProvider>
            <AppShellBoundary>
              <Bomb armed />
            </AppShellBoundary>
          </I18nProvider>,
        ),
      );

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Keiko konnte den Arbeitsbereich nicht öffnen",
        ),
      );
    } finally {
      warnSpy.mockRestore();
      window.localStorage.removeItem("keiko.locale");
    }
  });

  // The boundary only helps if it is above the shell in the tree the product actually renders.
  // AppShellFrame is that tree; AppShell passes <AppShellInner /> through it as `children`.
  it("catches a shell throw inside the real AppShellFrame provider tree", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      withBoundaryNoise("forced shell defect", () =>
        render(
          <AppShellFrame>
            <Bomb armed />
          </AppShellFrame>,
        ),
      );

      expect(screen.getByRole("alert").textContent).toContain("Keiko could not open the workspace");
      expect(document.querySelector("[data-app-shell-crashed]")).not.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The recovery surface is the ONLY thing on screen when it shows, so it has to be operable on its
  // own terms — an inaccessible last resort is not a recovery path.
  it("exposes no axe violations on the recovery surface", async () => {
    const { container, warnSpy } = renderBoundary(<Bomb armed />, {});
    try {
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps a healthy shell mounted inside the real AppShellFrame provider tree", () => {
    render(
      <AppShellFrame>
        <Bomb armed={false} />
      </AppShellFrame>,
    );

    expect(screen.getByText("desktop rendered")).toBeTruthy();
  });
});
