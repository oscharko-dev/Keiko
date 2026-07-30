import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstallPrompt } from "./useInstallPrompt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type UserChoiceOutcome = "accepted" | "dismissed";

function makePromptEvent(outcome: UserChoiceOutcome = "accepted"): Event & {
  preventDefault: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: UserChoiceOutcome; platform: string }>;
  platforms: readonly string[];
} {
  const promptFn = vi.fn().mockResolvedValue(undefined);
  const preventDefaultFn = vi.fn();
  const userChoice = Promise.resolve({ outcome, platform: "web" });

  const event = Object.assign(new Event("beforeinstallprompt"), {
    platforms: ["web"] as readonly string[],
    userChoice,
    prompt: promptFn,
    preventDefault: preventDefaultFn,
  });

  return event as typeof event;
}

function fireBeforeInstallPrompt(event: Event): void {
  window.dispatchEvent(event);
}

function fireAppInstalled(): void {
  window.dispatchEvent(new Event("appinstalled"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useInstallPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts with available=false", () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.available).toBe(false);
  });

  it("sets available=true when beforeinstallprompt fires", () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent();

    act(() => {
      fireBeforeInstallPrompt(event);
    });

    expect(result.current.available).toBe(true);
  });

  it("calls preventDefault() on beforeinstallprompt to suppress auto-infobar", () => {
    renderHook(() => useInstallPrompt());
    const event = makePromptEvent();

    act(() => {
      fireBeforeInstallPrompt(event);
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("triggerInstall calls the deferred prompt's .prompt()", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent("accepted");

    act(() => {
      fireBeforeInstallPrompt(event);
    });

    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(event.prompt).toHaveBeenCalledOnce();
  });

  it("sets localStorage keiko.pwa.installed=true when outcome is accepted", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent("accepted");

    act(() => {
      fireBeforeInstallPrompt(event);
    });

    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(localStorage.getItem("keiko.pwa.installed")).toBe("true");
  });

  it("does NOT set localStorage installed when outcome is dismissed", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent("dismissed");

    act(() => {
      fireBeforeInstallPrompt(event);
    });

    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(localStorage.getItem("keiko.pwa.installed")).toBeNull();
  });

  it("sets available=false after triggerInstall regardless of outcome", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent("dismissed");

    act(() => {
      fireBeforeInstallPrompt(event);
    });
    expect(result.current.available).toBe(true);

    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(result.current.available).toBe(false);
  });

  it("sets localStorage installed and clears available when appinstalled fires", () => {
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent();

    act(() => {
      fireBeforeInstallPrompt(event);
    });
    expect(result.current.available).toBe(true);

    act(() => {
      fireAppInstalled();
    });

    expect(localStorage.getItem("keiko.pwa.installed")).toBe("true");
    expect(result.current.available).toBe(false);
  });

  it("triggerInstall is a no-op when no prompt is stored", async () => {
    const { result } = renderHook(() => useInstallPrompt());

    // Should not throw
    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(result.current.available).toBe(false);
    expect(localStorage.getItem("keiko.pwa.installed")).toBeNull();
  });

  // 0.3.0 release audit — `localStorage.setItem` is not total: Safari private mode and an
  // exhausted quota both make it throw. Both writes here sit BEFORE the lines that retire the
  // consumed prompt, so a throw left the hook reporting `available: true` for a prompt the browser
  // can never show again — the Install button then silently does nothing.
  it("retires the consumed prompt even when persisting the accepted install throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { result } = renderHook(() => useInstallPrompt());
    const event = makePromptEvent("accepted");

    act(() => {
      fireBeforeInstallPrompt(event);
    });
    expect(result.current.available).toBe(true);

    await act(async () => {
      await result.current.triggerInstall();
    });

    expect(result.current.available).toBe(false);
  });

  it("retires the consumed prompt even when persisting an appinstalled event throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { result } = renderHook(() => useInstallPrompt());

    act(() => {
      fireBeforeInstallPrompt(makePromptEvent());
    });
    expect(result.current.available).toBe(true);

    act(() => {
      fireAppInstalled();
    });

    expect(result.current.available).toBe(false);
  });

  it("removes both event listeners on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useInstallPrompt());

    unmount();

    const removedNames = removeSpy.mock.calls.map((call) => call[0]);
    expect(removedNames).toContain("beforeinstallprompt");
    expect(removedNames).toContain("appinstalled");
  });
});
