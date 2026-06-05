import { describe, expect, it } from "vitest";
import { isCancelled } from "../cancellation.js";

describe("isCancelled", () => {
  it("returns false for undefined signal", () => {
    expect(isCancelled(undefined)).toBe(false);
  });

  it("returns false for an un-aborted signal", () => {
    const controller = new AbortController();
    expect(isCancelled(controller.signal)).toBe(false);
  });

  it("returns true after the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancelled(controller.signal)).toBe(true);
  });
});
