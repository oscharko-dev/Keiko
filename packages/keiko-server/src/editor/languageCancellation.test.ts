import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  createDeadlineCancellation,
  isCancellation,
  LanguageCancelledError,
} from "./languageCancellation.js";

describe("isCancellation", () => {
  it("recognises both the TypeScript and the transport-neutral cancellation errors", () => {
    expect(isCancellation(new ts.OperationCanceledException())).toBe(true);
    expect(isCancellation(new LanguageCancelledError())).toBe(true);
  });

  it("does not treat an ordinary error as cancellation", () => {
    expect(isCancellation(new Error("boom"))).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });
});

describe("createDeadlineCancellation", () => {
  it("reports an aborted signal as the 'aborted' reason and throws", () => {
    const controller = new AbortController();
    controller.abort();
    const cancellation = createDeadlineCancellation({
      signal: controller.signal,
      deadlineMs: 5_000,
    });
    expect(cancellation.isCancellationRequested()).toBe(true);
    expect(cancellation.reason()).toBe("aborted");
    expect(() => {
      cancellation.throwIfCancellationRequested();
    }).toThrow(LanguageCancelledError);
  });

  it("reports an elapsed deadline as the 'timeout' reason", () => {
    let tick = 0;
    const cancellation = createDeadlineCancellation({
      deadlineMs: 0,
      now: (): number => {
        tick += 10;
        return tick;
      },
    });
    expect(cancellation.isCancellationRequested()).toBe(true);
    expect(cancellation.reason()).toBe("timeout");
  });

  it("is not cancelled before the deadline with no signal, and exposes a host token", () => {
    const cancellation = createDeadlineCancellation({
      deadlineMs: 60_000,
      now: (): number => 1_000,
    });
    expect(cancellation.isCancellationRequested()).toBe(false);
    expect(cancellation.reason()).toBeUndefined();
    expect(cancellation.hostToken().isCancellationRequested()).toBe(false);
  });
});
