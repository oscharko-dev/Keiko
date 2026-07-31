// The client diagnostic sink: the redaction rule it makes enforceable, and the reason its default
// buffers instead of dropping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
} from "./client-diagnostics";
import { clientErrorSummary } from "./client-error-summary";

// The shared setup installs the application's console transport for every test, which is what the
// rest of the suite should exercise. These cases are about the sink BEFORE any transport exists, so
// they establish that precondition explicitly rather than assuming an empty sink.
beforeEach(() => {
  resetClientDiagnosticWriter();
});

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("reportClientDiagnostic", () => {
  it("routes through the installed transport and never touches the console itself", () => {
    const written: string[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setClientDiagnosticWriter((message) => written.push(message));

    reportClientDiagnostic("workspace-state: pull failed (network error)");

    expect(written).toEqual(["workspace-state: pull failed (network error)"]);
    // The sink owns the contract, not a transport: it is the transport module that may write to a
    // console, so this module must not — no matter which writer is installed.
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  // This is the property that rules out the obvious "no-op until a host installs a writer" default.
  // Diagnostics raised during module init, hydration, or an early boot crash all happen before any
  // host code can run — which is exactly when they matter most (AGENTS.md §7: no silent failures).
  it("holds diagnostics raised before a transport exists and delivers them in order", () => {
    reportClientDiagnostic("boot: first");
    reportClientDiagnostic("boot: second");

    const written: string[] = [];
    setClientDiagnosticWriter((message) => written.push(message));

    expect(written).toEqual(["boot: first", "boot: second"]);
  });

  it("delivers the buffer exactly once, not again to the next transport", () => {
    reportClientDiagnostic("boot: only");
    const first: string[] = [];
    setClientDiagnosticWriter((message) => first.push(message));

    const second: string[] = [];
    setClientDiagnosticWriter((message) => second.push(message));

    expect(first).toEqual(["boot: only"]);
    expect(second).toEqual([]);
  });

  // A failing poll loop can raise one diagnostic per tick while the BFF restarts. The pre-transport
  // buffer is bounded so that storm cannot grow without limit; the oldest go first because a storm's
  // later entries describe the same fault as its first.
  it("bounds the pre-transport buffer and drops the oldest first", () => {
    for (let index = 0; index < 150; index += 1) reportClientDiagnostic(`tick ${String(index)}`);

    const written: string[] = [];
    setClientDiagnosticWriter((message) => written.push(message));

    expect(written).toHaveLength(100);
    expect(written[0]).toBe("tick 50");
    expect(written.at(-1)).toBe("tick 149");
  });

  it("discards anything held when the sink is reset", () => {
    reportClientDiagnostic("boot: dropped by reset");
    resetClientDiagnosticWriter();

    const written: string[] = [];
    setClientDiagnosticWriter((message) => written.push(message));

    expect(written).toEqual([]);
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
