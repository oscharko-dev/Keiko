// The client diagnostic sink and the redaction rule it exists to make enforceable.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
} from "./client-diagnostics";
import { clientErrorSummary } from "./client-error-summary";

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("reportClientDiagnostic", () => {
  it("routes through the replaceable writer rather than the console", () => {
    const written: string[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setClientDiagnosticWriter((message) => written.push(message));

    reportClientDiagnostic("workspace-state: pull failed (network error)");

    expect(written).toEqual(["workspace-state: pull failed (network error)"]);
    // The seam is the point: a host that replaces the writer takes the console out of the path
    // entirely, which is what makes this testable and replaceable rather than a convention.
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("falls back to the console when no writer was installed", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    reportClientDiagnostic("shell-shortcuts: refused persisted keybinding overrides");

    expect(consoleWarn).toHaveBeenCalledWith(
      "shell-shortcuts: refused persisted keybinding overrides",
    );
    consoleWarn.mockRestore();
  });
});

describe("clientErrorSummary", () => {
  // The sink takes a string, so an error can only reach it through this function — which is exactly
  // how the type stops a raw Error, its stack, or its message from reaching a surface users
  // screenshot into bug reports.
  it("yields the error class and never its message or stack", () => {
    const error = new TypeError("/Users/someone/secret-project/app.ts is not a function");

    const summary = clientErrorSummary(error);

    expect(summary).toBe("TypeError");
    expect(summary).not.toContain("secret-project");
    expect(summary).not.toContain("is not a function");
  });

  it("names a nameless error rather than emitting an empty diagnostic", () => {
    const error = new Error("boom");
    error.name = "   ";

    expect(clientErrorSummary(error)).toBe("Error");
  });

  it("describes a thrown non-error by its type, without quoting it", () => {
    expect(clientErrorSummary("s3cr3t-token-value")).toBe("string");
    expect(clientErrorSummary({ token: "s3cr3t" })).toBe("object");
    expect(clientErrorSummary(undefined)).toBe("undefined");
  });
});
