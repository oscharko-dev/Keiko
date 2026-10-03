// #3532 — uncaught `window` errors reach the one client diagnostic sink by class only, with the
// closed kind `window-error`; a per-session cap bounds a storm and counts every error past it.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetClientDiagnosticWriter,
  currentGlobalClientFailure,
  setClientDiagnosticWriter,
  takeClientDiagnosticLoss,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { useWindowErrorLog } from "./useWindowErrorLog";

interface Received {
  readonly message: string;
  readonly meta: ClientDiagnosticMeta | undefined;
}

let received: Received[] = [];

function dispatchWindowError(error: unknown): void {
  window.dispatchEvent(new ErrorEvent("error", { error, message: "raw browser message" }));
}

beforeEach(() => {
  received = [];
  setClientDiagnosticWriter((message, meta) => received.push({ message, meta }));
});

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("useWindowErrorLog", () => {
  it("ignores browser resize notifications before the real-error cap", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    for (let index = 0; index < 8; index += 1) {
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: null,
          message: "ResizeObserver loop completed with undelivered notifications.",
        }),
      );
    }
    expect(currentGlobalClientFailure()).toBeNull();
    dispatchWindowError(new TypeError("real failure"));
    view.unmount();
    expect(received).toHaveLength(1);
    expect(received[0]?.meta?.errorEvidence?.errorClass).toBe("TypeError");
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });

  it("does not dismiss thrown errors that copy the resize notification text", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    const message = "ResizeObserver loop completed with undelivered notifications.";
    window.dispatchEvent(new ErrorEvent("error", { error: new Error(message), message }));
    view.unmount();
    expect(received).toHaveLength(1);
    expect(currentGlobalClientFailure()).not.toBeNull();
  });

  it("reports an uncaught error by its class only, with the closed kind", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    dispatchWindowError(new TypeError("token=sk-secret at /Users/alice/app.ts"));
    view.unmount();

    expect(received).toEqual([
      {
        message: "[keiko] uncaught window error: TypeError",
        meta: {
          kind: "window-error",
          globalFailure: true,
          correlationId: expect.any(String),
          errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
        },
      },
    ]);
    expect(currentGlobalClientFailure()?.correlationId).toBe(received[0]?.meta?.correlationId);
    for (const { message } of received) {
      expect(message).not.toContain("sk-secret");
      expect(message).not.toContain("raw browser message");
    }
  });

  it("preserves safe shipped chunk coordinates without customer prose or paths", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    const cause = new TypeError("ClientAcmePayroll token=sk-secret");
    cause.stack = `TypeError: ClientAcmePayroll\n    at customerFunction (${location.origin}/_next/static/chunks/1wntg-7ptuw73.js:20:400)`;
    const error = new Error("ClientAcmePayroll at /Users/alice/private.ts", { cause });
    error.stack = `Error: ClientAcmePayroll\n    at customerFunction (${location.origin}/_next/static/chunks/1wntg-7ptuw73.js:10:200)\n    at customerFunction (${location.origin}/Users/alice/private.ts:12:34)`;
    dispatchWindowError(error);
    view.unmount();
    expect(received[0]?.meta?.errorEvidence).toEqual({
      errorClass: "Error",
      frames: [
        "dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:20:400",
        "dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:10:200",
      ],
      causeChain: ["TypeError"],
    });
    expect(JSON.stringify(received)).not.toMatch(
      /ClientAcmePayroll|sk-secret|customerFunction|Users|https?:/u,
    );
  });

  it("caps the reports per session and counts every error past the cap as suppressed", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    for (let index = 0; index < 9; index += 1) dispatchWindowError(new Error(String(index)));
    view.unmount();

    expect(received).toHaveLength(5);
    expect(takeClientDiagnosticLoss()).toEqual({ errorsSuppressed: 4 });
  });

  it("removes the listener on unmount", () => {
    const view = renderHook(() => {
      useWindowErrorLog();
    });
    view.unmount();
    // Vitest's jsdom environment rethrows an error event as an uncaught exception once no `error`
    // listener is registered, so a test-owned listener absorbs this one. It does not hide the hook:
    // a hook listener still attached would receive the same event and report it.
    const absorb = (event: ErrorEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("error", absorb);
    try {
      dispatchWindowError(new Error("after unmount"));
    } finally {
      window.removeEventListener("error", absorb);
    }

    expect(received).toEqual([]);
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  });
});
