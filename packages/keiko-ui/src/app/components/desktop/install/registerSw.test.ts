import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSw } from "./registerSw";

// jsdom does not expose `navigator.serviceWorker`. We define it ad-hoc per test so the
// shape and behaviour of `register()` is fully controlled.
interface FakeServiceWorkerContainer {
  register: ReturnType<typeof vi.fn>;
}

function installServiceWorker(container: FakeServiceWorkerContainer): void {
  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
    writable: true,
  });
}

function removeServiceWorker(): void {
  if ("serviceWorker" in navigator) {
    // `delete` on a defined property works because we set `configurable: true` above.
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
}

describe("registerSw (issue #126)", () => {
  beforeEach(() => {
    removeServiceWorker();
  });

  afterEach(() => {
    removeServiceWorker();
    vi.restoreAllMocks();
  });

  it("calls navigator.serviceWorker.register with /sw.js and scope '/'", () => {
    const register = vi.fn().mockResolvedValue({});
    installServiceWorker({ register });

    registerSw();

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("is a no-op when navigator.serviceWorker is undefined", () => {
    // No installServiceWorker — the guard must short-circuit.
    expect(() => {
      registerSw();
    }).not.toThrow();
  });

  it("does not throw when register() rejects (failure is silent)", async () => {
    const error = new Error("CSP blocked the worker");
    const register = vi.fn().mockRejectedValue(error);
    installServiceWorker({ register });

    // Spy on the unhandledrejection path: if the helper leaks a rejection, jsdom will
    // surface it as an unhandled rejection event on the global.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    registerSw();

    // Wait two microtask flushes — once for `register()` to reject and once for `.catch`
    // to resolve to undefined. After that, no unhandled rejection should be queued.
    await Promise.resolve();
    await Promise.resolve();

    process.off("unhandledRejection", unhandled);

    expect(register).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("does not throw if register() itself throws synchronously (silent-failure contract)", () => {
    // A non-conforming runtime could throw synchronously instead of returning a rejected
    // Promise. The helper MUST still degrade silently — the install banner falls back to
    // manual instructions in that case (per ADR-0024 D6).
    const register = vi.fn().mockImplementation(() => {
      throw new Error("Synchronous failure");
    });
    installServiceWorker({ register });

    expect(() => {
      registerSw();
    }).not.toThrow();
  });
});
