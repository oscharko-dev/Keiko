// The client diagnostic sink: the redaction rule it makes enforceable, and the reason its default
// buffers instead of dropping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  recordClientDiagnosticLoss,
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  restoreClientDiagnosticLoss,
  setClientDiagnosticWriter,
  takeClientDiagnosticLoss,
  type ClientDiagnosticMeta,
} from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";

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
    // #3532: the 50 evicted records are counted, never silently gone.
    expect(takeClientDiagnosticLoss()).toEqual({ bufferEvicted: 50 });
  });

  it("discards anything held when the sink is reset", () => {
    reportClientDiagnostic("boot: dropped by reset");
    resetClientDiagnosticWriter();

    const written: string[] = [];
    setClientDiagnosticWriter((message) => written.push(message));

    expect(written).toEqual([]);
  });

  // Wave 5 follow-up (epic #3233): the second argument is how a call site that holds an ApiError
  // hands its correlation id to a transport, without folding it into the message string.
  it("passes a supplied correlationId through to the installed writer", () => {
    const received: (ClientDiagnosticMeta | undefined)[] = [];
    setClientDiagnosticWriter((_message, meta) => received.push(meta));

    reportClientDiagnostic("desktop shell crashed", { correlationId: "req-abc12345" });

    expect(received).toEqual([{ correlationId: "req-abc12345" }]);
  });

  it("passes undefined meta through unchanged when the caller has no correlation id", () => {
    const received: (ClientDiagnosticMeta | undefined)[] = [];
    setClientDiagnosticWriter((_message, meta) => received.push(meta));

    reportClientDiagnostic("workspace-state: local persistence parse failed");

    expect(received).toEqual([undefined]);
  });

  // The pre-transport buffer must replay each record's OWN meta, not lose it or leak a later
  // record's id onto an earlier one — the same in-order guarantee the plain-message buffering test
  // above already covers for `message`.
  it("replays buffered diagnostics with their original correlationId, each kept separate", () => {
    reportClientDiagnostic("boot: first", { correlationId: "req-boot-000001" });
    reportClientDiagnostic("boot: second");
    reportClientDiagnostic("boot: third", { correlationId: "req-boot-000003" });

    const received: (ClientDiagnosticMeta | undefined)[] = [];
    setClientDiagnosticWriter((_message, meta) => received.push(meta));

    expect(received).toEqual([
      { correlationId: "req-boot-000001" },
      undefined,
      { correlationId: "req-boot-000003" },
    ]);
  });
});

// #3532: the page's own delivery-loss ledger — closed keys, bounded counts, handed to a transport
// once and given back exactly when that delivery fails.
describe("client diagnostic loss ledger", () => {
  it("has nothing to hand over while nothing was lost", () => {
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });

  it("hands the counts over once and clears them", () => {
    recordClientDiagnosticLoss("postsThrottled");
    recordClientDiagnosticLoss("postsThrottled");
    recordClientDiagnosticLoss("rejectionsSuppressed", 4);

    expect(takeClientDiagnosticLoss()).toEqual({ postsThrottled: 2, rejectionsSuppressed: 4 });
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });

  // Regression: an absent key used to be restored as `undefined`, which took the default count of
  // one and invented a loss of every other kind on each failed delivery.
  it("restores exactly the counts a failed delivery gives back", () => {
    restoreClientDiagnosticLoss({ errorsSuppressed: 3 });
    restoreClientDiagnosticLoss(undefined);

    expect(takeClientDiagnosticLoss()).toEqual({ errorsSuppressed: 3 });
  });

  it("ignores invalid counts and saturates at the contract ceiling", () => {
    recordClientDiagnosticLoss("postsFailed", 0);
    recordClientDiagnosticLoss("postsFailed", -2);
    recordClientDiagnosticLoss("postsFailed", 1.5);
    expect(takeClientDiagnosticLoss()).toBeUndefined();

    recordClientDiagnosticLoss("bufferEvicted", CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX);
    recordClientDiagnosticLoss("bufferEvicted", 10);
    expect(takeClientDiagnosticLoss()).toEqual({ bufferEvicted: CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX });
  });

  it("clears counted loss when the sink is reset", () => {
    recordClientDiagnosticLoss("postsFailed");
    resetClientDiagnosticWriter();

    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });
});

describe("correlationIdOf", () => {
  it("recovers a string correlationId from any error-shaped object that carries one", () => {
    const apiErrorShaped = Object.assign(new Error("boom"), { correlationId: "req-xyz12345" });

    expect(correlationIdOf(apiErrorShaped)).toBe("req-xyz12345");
  });

  it("returns undefined for an error with no correlationId, or a non-error thrown value", () => {
    expect(correlationIdOf(new Error("boom"))).toBeUndefined();
    expect(correlationIdOf("plain string throw")).toBeUndefined();
    expect(correlationIdOf(undefined)).toBeUndefined();
    expect(correlationIdOf(null)).toBeUndefined();
  });

  it("ignores a non-string correlationId field rather than passing it through unchecked", () => {
    const malformed = Object.assign(new Error("boom"), { correlationId: 12345 });

    expect(correlationIdOf(malformed)).toBeUndefined();
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
