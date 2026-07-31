// The application's chosen diagnostic transport. Separate from the sink's own tests on purpose: this
// is the only module in keiko-ui production code permitted to write to a console, so the assertion
// that it does — and that it does nothing else — lives where a reviewer looks for it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeToBrowserConsole } from "./install-client-diagnostics";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
} from "./client-diagnostics";

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("writeToBrowserConsole", () => {
  it("writes the message verbatim and adds nothing of its own", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    writeToBrowserConsole("shell-shortcuts: refused persisted keybinding overrides");

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    // Verbatim: the transport must not decorate, prefix, or re-serialise. Redaction happened at the
    // call site and anything added here would be text no reviewer checked.
    expect(consoleWarn).toHaveBeenCalledWith(
      "shell-shortcuts: refused persisted keybinding overrides",
    );
    consoleWarn.mockRestore();
  });

  it("is what importing this module installs, so a boot-time diagnostic reaches the console", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The import side effect already ran; re-install it explicitly so this assertion does not depend
    // on whether another suite in this worker replaced the writer first.
    setClientDiagnosticWriter(writeToBrowserConsole);

    reportClientDiagnostic("boot: gateway probe failed (TypeError)");

    expect(consoleWarn).toHaveBeenCalledWith("boot: gateway probe failed (TypeError)");
    consoleWarn.mockRestore();
  });
});
