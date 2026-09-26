import { describe, expect, it } from "vitest";

import { deriveStatusViewModel } from "./status-text.js";
import type { KeikoEditorLoadState } from "./types.js";

const ready: KeikoEditorLoadState = { status: "ready" };

describe("deriveStatusViewModel", () => {
  it("is a polite status while loading", () => {
    const vm = deriveStatusViewModel({
      loadState: { status: "loading" },
      saveStatus: "idle",
      dirty: false,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("status");
    expect(vm.ariaLive).toBe("polite");
    expect(vm.message).toContain("Loading");
  });

  it("is an assertive alert when the runtime failed to load", () => {
    const vm = deriveStatusViewModel({
      loadState: { status: "error", message: "worker boot failed" },
      saveStatus: "idle",
      dirty: false,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("alert");
    expect(vm.ariaLive).toBe("assertive");
    expect(vm.message).toContain("worker boot failed");
  });

  it("reports unsaved changes politely when dirty and idle", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "idle",
      dirty: true,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("status");
    expect(vm.message).toBe("Unsaved changes");
  });

  it("reports saving politely", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "saving",
      dirty: true,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("status");
    expect(vm.message).toBe("Saving…");
  });

  it("includes the saved timestamp on success", () => {
    const at = Date.UTC(2026, 5, 18, 12, 0, 0);
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "saved",
      dirty: false,
      truncated: false,
      overLimit: false,
      modifiedAt: at,
    });
    expect(vm.message).toContain(new Date(at).toISOString());
  });

  it("is an assertive alert and surfaces the error message on save error", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "error",
      saveError: "disk full",
      dirty: true,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("alert");
    expect(vm.message).toContain("disk full");
  });

  it("is an assertive alert on a save conflict", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "conflict",
      dirty: true,
      truncated: false,
      overLimit: false,
    });
    expect(vm.role).toBe("alert");
    expect(vm.message).toContain("conflict");
  });

  it("appends a truncation notice", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "idle",
      dirty: false,
      truncated: true,
      overLimit: false,
    });
    expect(vm.message).toContain("truncated");
  });

  it("appends a size-limit notice when overLimit is true (KEIKO-0259)", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "idle",
      dirty: false,
      truncated: false,
      overLimit: true,
    });
    expect(vm.role).toBe("status");
    expect(vm.ariaLive).toBe("polite");
    expect(vm.message).toContain("size limit");
    expect(vm.message).toContain("read-only");
  });

  it("composes both notices when the file is truncated and over the size limit (#2898)", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "idle",
      dirty: false,
      truncated: true,
      overLimit: true,
    });
    expect(vm.message).toContain("size limit");
    expect(vm.message).toContain("display limit");
    expect(vm.message).toBe(
      "Ready File exceeds the size limit and is read-only." +
        " File is truncated (read-only): it exceeds the display limit.",
    );
  });

  // KEIKO-0721: `Date.prototype.toISOString()` throws `RangeError: Invalid time value` for NaN,
  // +/-Infinity, or any value that produces an out-of-range Date. The undefined-only guard the
  // function shipped with therefore let a non-finite `modifiedAt` throw out of the render path.
  it("returns the absent-timestamp fallback for a non-finite modifiedAt (KEIKO-0721)", () => {
    for (const modifiedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const vm = deriveStatusViewModel({
        loadState: ready,
        saveStatus: "saved",
        dirty: false,
        truncated: false,
        overLimit: false,
        modifiedAt,
      });
      expect(vm.role).toBe("status");
      expect(vm.message).toBe("Saved");
    }
  });

  // PR #3289 review (comment 3865167748): `Number.isFinite` alone is not enough -- ECMAScript
  // Date only represents +/-8_640_000_000_000_000 ms from the epoch. A finite value one past that
  // limit (or any other finite-but-out-of-range value, e.g. Number.MAX_VALUE) still makes
  // `new Date(value).toISOString()` throw `RangeError: Invalid time value`, so the finiteness-only
  // guard let this exact class of value crash the render path.
  it("returns the absent-timestamp fallback for a finite but out-of-ECMA-range modifiedAt", () => {
    for (const modifiedAt of [
      8_640_000_000_000_001,
      -8_640_000_000_000_001,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]) {
      expect(() =>
        deriveStatusViewModel({
          loadState: ready,
          saveStatus: "saved",
          dirty: false,
          truncated: false,
          overLimit: false,
          modifiedAt,
        }),
      ).not.toThrow();
      const vm = deriveStatusViewModel({
        loadState: ready,
        saveStatus: "saved",
        dirty: false,
        truncated: false,
        overLimit: false,
        modifiedAt,
      });
      expect(vm.role).toBe("status");
      expect(vm.message).toBe("Saved");
    }
  });

  // The boundary itself is a VALID Date and must keep formatting normally -- only values strictly
  // beyond the ECMA range fall back.
  it("formats a modifiedAt exactly at the ECMA Date range boundary", () => {
    const vm = deriveStatusViewModel({
      loadState: ready,
      saveStatus: "saved",
      dirty: false,
      truncated: false,
      overLimit: false,
      modifiedAt: 8_640_000_000_000_000,
    });
    expect(vm.message).toBe(`Saved at ${new Date(8_640_000_000_000_000).toISOString()}`);
  });
});
