import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeedbackPublicWindowGuard,
  initializeFeedbackPublicWindow,
  isolateFeedbackPublicWindow,
  reserveFeedbackPublicWindow,
  type FeedbackReservedWindow,
} from "./feedback-public-window";

function reservedWindow() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    document: document.implementation.createHTMLDocument(),
    location: { replace: vi.fn<(url: string) => void>() },
  } satisfies FeedbackReservedWindow;
}

afterEach(() => vi.restoreAllMocks());

describe("feedback public window reservation", () => {
  it("initializes a localized content-free status before severing the opener", () => {
    const reserved = reservedWindow();
    const events: string[] = [];
    const replaceChildren = reserved.document.body.replaceChildren.bind(reserved.document.body);
    vi.spyOn(reserved.document.body, "replaceChildren").mockImplementation((...nodes) => {
      events.push("status");
      replaceChildren(...nodes);
    });
    Object.defineProperty(reserved, "opener", {
      configurable: true,
      get: () => null,
      set: () => events.push("opener"),
    });

    expect(
      initializeFeedbackPublicWindow(reserved, {
        language: "de",
        status: "Oeffentliches GitHub-Formular wird geoeffnet…",
        title: "Oeffentliches GitHub-Formular wird geoeffnet",
      }),
    ).toBe(true);
    expect(isolateFeedbackPublicWindow(reserved)).toBe(true);

    const status = reserved.document.body.querySelector('[role="status"]');
    expect(reserved.document.title).toBe("Oeffentliches GitHub-Formular wird geoeffnet");
    expect(reserved.document.documentElement.lang).toBe("de");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.textContent).toBe("Oeffentliches GitHub-Formular wird geoeffnet…");
    expect(reserved.document.body.textContent).not.toContain("raw-public-handoff-sentinel");
    expect(reserved.document.body.textContent).not.toContain("github.com/issues/new");
    expect(events).toEqual(["status", "opener"]);
  });

  it("reserves only about:blank and severs its opener synchronously", () => {
    const reserved = reservedWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);

    expect(reserveFeedbackPublicWindow()).toBe(reserved);
    expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(JSON.stringify(open.mock.calls)).not.toContain("github.com");
    expect(isolateFeedbackPublicWindow(reserved)).toBe(true);
    expect(reserved.opener).toBeNull();
  });

  it("closes a held reservation when its prepared digest is deactivated", () => {
    const reserved = reservedWindow();
    const guard = new FeedbackPublicWindowGuard();
    guard.activate("a".repeat(64));
    const generation = guard.begin("a".repeat(64));
    expect(generation).toBeDefined();
    if (generation === undefined) return;

    expect(guard.hold("a".repeat(64), generation, reserved)).toBe(true);
    guard.deactivate();

    expect(reserved.close).toHaveBeenCalledOnce();
    expect(reserved.location.replace).not.toHaveBeenCalled();
  });
});
