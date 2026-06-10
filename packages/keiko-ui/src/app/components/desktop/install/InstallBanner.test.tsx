import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallBanner } from "./InstallBanner";

// ---------------------------------------------------------------------------
// Helpers to simulate browser state
// ---------------------------------------------------------------------------

function setStandalone(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === "(display-mode: standalone)" ? matches : false,
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

function makePromptEvent(outcome: "accepted" | "dismissed" = "accepted"): Event & {
  preventDefault: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
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

// ---------------------------------------------------------------------------
// Mock detectSupport so we can control the reported support level
// ---------------------------------------------------------------------------

vi.mock("./browserSupport", () => ({
  detectSupport: vi.fn((_ua: string) => "supported"),
}));

import { detectSupport } from "./browserSupport";
const mockDetectSupport = vi.mocked(detectSupport);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InstallBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    // Default: non-standalone, support=supported
    setStandalone(false);
    mockDetectSupport.mockReturnValue("supported");
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // ── Visibility gates ──────────────────────────────────────────────────────

  it("renders nothing when display-mode is standalone", () => {
    setStandalone(true);
    // Fire beforeinstallprompt so available=true (wouldn't matter here, but covers guard order)
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when keiko.pwa.installed is true", () => {
    localStorage.setItem("keiko.pwa.installed", "true");
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when keiko.pwa.dismissed is set", () => {
    localStorage.setItem("keiko.pwa.dismissed", new Date().toISOString());
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when support level is manual", () => {
    mockDetectSupport.mockReturnValue("manual");
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when support=supported but no beforeinstallprompt captured yet", () => {
    mockDetectSupport.mockReturnValue("supported");
    // No event fired
    const { container } = render(<InstallBanner />);
    expect(container.firstChild).toBeNull();
  });

  // ── Chromium (supported) path ─────────────────────────────────────────────

  it("renders Install button when beforeinstallprompt was captured", () => {
    render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByRole("button", { name: /Install Keiko/i })).toBeInTheDocument();
  });

  it("renders the region landmark with correct label", () => {
    render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByRole("region", { name: "Install Keiko" })).toBeInTheDocument();
  });

  it("clicking Install calls the deferred prompt and sets installed on accepted", async () => {
    render(<InstallBanner />);
    const event = makePromptEvent("accepted");
    act(() => {
      window.dispatchEvent(event);
    });

    const installBtn = screen.getByRole("button", { name: /Install Keiko/i });
    await act(async () => {
      fireEvent.click(installBtn);
      // Allow microtask queue to flush (userChoice resolution)
      await Promise.resolve();
    });

    expect(event.prompt).toHaveBeenCalledOnce();
    expect(localStorage.getItem("keiko.pwa.installed")).toBe("true");
  });

  it("clicking Install hides the banner after accepted", async () => {
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent("accepted");
    act(() => {
      window.dispatchEvent(event);
    });

    const installBtn = screen.getByRole("button", { name: /Install Keiko/i });
    await act(async () => {
      fireEvent.click(installBtn);
      await Promise.resolve();
    });

    expect(container.firstChild).toBeNull();
  });

  // ── Dismiss path ──────────────────────────────────────────────────────────

  it("clicking Not now sets dismissed in localStorage and hides banner", () => {
    render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });

    const dismissBtn = screen.getByRole("button", { name: /dismiss install banner/i });
    act(() => {
      fireEvent.click(dismissBtn);
    });

    expect(localStorage.getItem("keiko.pwa.dismissed")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Install Keiko" })).toBeNull();
  });

  it("pressing Escape dismisses the banner", () => {
    render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(localStorage.getItem("keiko.pwa.dismissed")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Install Keiko" })).toBeNull();
  });

  // ── iOS Add to Home Screen path ───────────────────────────────────────────

  it("renders iOS fallback instructions without an Install button", () => {
    mockDetectSupport.mockReturnValue("ios-add-to-home");
    render(<InstallBanner />);
    // No beforeinstallprompt needed for ios-add-to-home
    expect(screen.getByRole("region", { name: "Install Keiko" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install Keiko/i })).toBeNull();
    expect(screen.getByText(/tap share/i)).toBeInTheDocument();
  });

  it("renders the dismiss button for iOS path too", () => {
    mockDetectSupport.mockReturnValue("ios-add-to-home");
    render(<InstallBanner />);
    expect(screen.getByRole("button", { name: /dismiss install banner/i })).toBeInTheDocument();
  });

  // ── Tab order ─────────────────────────────────────────────────────────────

  it("Install button appears before dismiss button in DOM order (tab order Install→Close)", () => {
    render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });

    const buttons = screen.getAllByRole("button");
    const installIndex = buttons.findIndex((b) => /install keiko/i.test(b.textContent ?? ""));
    const dismissIndex = buttons.findIndex((b) =>
      /dismiss install banner/i.test(b.getAttribute("aria-label") ?? ""),
    );
    expect(installIndex).toBeLessThan(dismissIndex);
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  it("passes jest-axe with no violations (Chromium path)", async () => {
    const { container } = render(<InstallBanner />);
    const event = makePromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes jest-axe with no violations (iOS path)", async () => {
    mockDetectSupport.mockReturnValue("ios-add-to-home");
    const { container } = render(<InstallBanner />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
