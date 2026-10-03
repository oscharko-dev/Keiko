import { describe, expect, it } from "vitest";
import { isBenignWindowNotification, isMonacoCancellation } from "./benign-browser-error";

describe("exact benign browser notifications", () => {
  it.each([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
  ])("recognizes only a null-error resize notification: %s", (message) => {
    expect(isBenignWindowNotification(new ErrorEvent("error", { message, error: null }))).toBe(
      true,
    );
    expect(
      isBenignWindowNotification(new ErrorEvent("error", { message, error: new Error(message) })),
    ).toBe(false);
  });

  it("recognizes Monaco's exact cancellation in window events and rejects lookalikes", () => {
    const cancelled = Object.assign(new Error("Canceled"), { name: "Canceled" });
    expect(isMonacoCancellation(cancelled)).toBe(true);
    expect(isBenignWindowNotification(new ErrorEvent("error", { error: cancelled }))).toBe(true);
    for (const error of [
      new Error("Canceled"),
      Object.assign(new Error("Real failure"), { name: "Canceled" }),
      new DOMException("Cancelled", "AbortError"),
      new DOMException("Deadline", "TimeoutError"),
      "Canceled",
      { name: "Canceled", message: "Canceled" },
    ])
      expect(isMonacoCancellation(error)).toBe(false);
  });
});
