import { describe, expect, it } from "vitest";
import { composeCancellationSignal } from "../cancellation.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

describe("composeCancellationSignal", () => {
  it("fires the composed signal when the internal timeout elapses", async () => {
    const handle = composeCancellationSignal(20, undefined);
    expect(handle.signal.aborted).toBe(false);
    await waitForAbort(handle.signal);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.reasonKind()).toBe("timeout");
    handle.dispose();
  });

  it("fires the composed signal when the external signal aborts", async () => {
    const external = new AbortController();
    const handle = composeCancellationSignal(10_000, external.signal);
    expect(handle.signal.aborted).toBe(false);
    external.abort();
    await waitForAbort(handle.signal);
    expect(handle.reasonKind()).toBe("external");
    handle.dispose();
  });

  it("aborts immediately when the external signal is already aborted", () => {
    const external = new AbortController();
    external.abort();
    const handle = composeCancellationSignal(10_000, external.signal);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.reasonKind()).toBe("external");
    handle.dispose();
  });

  it("dispose() detaches the timer so it does not leak", () => {
    const handle = composeCancellationSignal(10_000, undefined);
    handle.dispose();
    expect(handle.reasonKind()).toBe("none");
  });

  it("does not start a timer when timeoutMs is zero", () => {
    const handle = composeCancellationSignal(0, undefined);
    expect(handle.signal.aborted).toBe(false);
    handle.dispose();
  });
});
