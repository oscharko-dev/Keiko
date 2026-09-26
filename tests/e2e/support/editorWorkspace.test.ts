import { describe, expect, it } from "vitest";

import { isBenignWebKitResizeObserverDelivery } from "./editorWorkspace.js";

function browserDiagnostic(message: string, stack = ""): Error {
  const error = new Error(message);
  error.stack = stack;
  return error;
}

describe("isBenignWebKitResizeObserverDelivery", () => {
  it("accepts WebKit's exact location-less delivery diagnostic", () => {
    expect(
      isBenignWebKitResizeObserverDelivery(
        "webkit",
        browserDiagnostic("ResizeObserver loop completed with undelivered notifications."),
      ),
    ).toBe(true);
  });

  it("does not hide an application error with the same message and a code stack", () => {
    expect(
      isBenignWebKitResizeObserverDelivery(
        "webkit",
        browserDiagnostic(
          "ResizeObserver loop completed with undelivered notifications.",
          "Error: ResizeObserver loop completed with undelivered notifications.\n    at app.ts:1:1",
        ),
      ),
    ).toBe(false);
  });

  it.each(["chromium", "firefox", undefined])(
    "does not suppress the diagnostic for %s",
    (browserName) => {
      expect(
        isBenignWebKitResizeObserverDelivery(
          browserName,
          browserDiagnostic("ResizeObserver loop completed with undelivered notifications."),
        ),
      ).toBe(false);
    },
  );

  it("rejects nearby ResizeObserver failures", () => {
    expect(
      isBenignWebKitResizeObserverDelivery(
        "webkit",
        browserDiagnostic("ResizeObserver callback failed"),
      ),
    ).toBe(false);
  });
});
