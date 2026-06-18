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
    });
    expect(vm.message).toContain("truncated");
  });
});
