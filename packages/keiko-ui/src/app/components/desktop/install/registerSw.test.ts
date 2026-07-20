import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSw } from "./registerSw";

// jsdom does not expose `navigator.serviceWorker`. We define it ad-hoc per test so the
// shape and behaviour of `register()` is fully controlled.
interface FakeServiceWorkerContainer {
  register: ReturnType<typeof vi.fn>;
  addEventListener?: ReturnType<typeof vi.fn>;
  getRegistrations?: ReturnType<typeof vi.fn>;
  controller?: ServiceWorker | null;
}

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

function installServiceWorker(container: FakeServiceWorkerContainer): void {
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      addEventListener: vi.fn(),
      controller: null,
      ...container,
    },
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

function installCaches(caches: Pick<CacheStorage, "keys" | "delete">): void {
  Object.defineProperty(globalThis, "caches", {
    value: caches,
    configurable: true,
  });
}

function restoreCaches(): void {
  if (originalCaches === undefined) {
    Reflect.deleteProperty(globalThis, "caches");
    return;
  }
  Object.defineProperty(globalThis, "caches", originalCaches);
}

// registerSw defers its container calls into the promise chain (so a synchronous throw from a
// non-conforming runtime becomes a rejection the single `.catch` absorbs), which costs a couple of
// extra hops on top of each `.then` the helper itself chains.
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

// Node reports an unhandled rejection only once the microtask queue is exhausted and the current
// turn of the event loop ends, so a microtask-only flush would let a leaked rejection pass
// unnoticed. `setImmediate` is the event-loop boundary that guarantees we resume after that point —
// it is a phase hand-off, not a timed sleep, so nothing here depends on wall-clock or CI load.
async function flushRejectionReporting(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// Attaching a process-global listener from a test leaks into every later test in the worker if an
// assertion throws first, so ownership is scoped to one call and released in a `finally`.
async function withUnhandledRejectionSpy(
  body: (unhandled: ReturnType<typeof vi.fn>) => Promise<void> | void,
): Promise<ReturnType<typeof vi.fn>> {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    await body(unhandled);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
  return unhandled;
}

describe("registerSw static-shell caching", () => {
  beforeEach(() => {
    removeServiceWorker();
    restoreCaches();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    removeServiceWorker();
    restoreCaches();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("calls navigator.serviceWorker.register with /sw.js and scope '/'", async () => {
    const register = vi.fn().mockResolvedValue({});
    installServiceWorker({ register });

    registerSw();
    await flushMicrotasks();

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

    // Spy on the unhandledrejection path: if the helper leaks a rejection, Node reports it once the
    // event loop turn ends.
    const unhandled = await withUnhandledRejectionSpy(async () => {
      registerSw();
      await flushRejectionReporting();
    });

    expect(register).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("does not throw if register() itself throws synchronously (silent-failure contract)", async () => {
    // A non-conforming runtime could throw synchronously instead of returning a rejected
    // Promise. The helper MUST still degrade silently — the install banner falls back to
    // manual instructions in that case (per ADR-0024 D6). The call is invoked inside the promise
    // chain, so that throw arrives as a rejection: assert it neither escapes the caller NOR leaks
    // as an unhandled rejection, which is the failure mode that shape could otherwise introduce.
    const register = vi.fn().mockImplementation(() => {
      throw new Error("Synchronous failure");
    });
    installServiceWorker({ register });

    const unhandled = await withUnhandledRejectionSpy(async () => {
      expect(() => {
        registerSw();
      }).not.toThrow();
      await flushRejectionReporting();
    });

    expect(register).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("asks an already waiting update to activate when the page has an active controller", async () => {
    const postMessage = vi.fn();
    const waiting = { postMessage } as unknown as ServiceWorker;
    const registrationAddEventListener = vi.fn();
    const registration = {
      waiting,
      installing: null,
      addEventListener: registrationAddEventListener,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    installServiceWorker({ controller: {} as ServiceWorker, register });

    registerSw();

    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: "KEIKO_ACTIVATE_WAITING_SERVICE_WORKER",
    });
    expect(window.sessionStorage.getItem("keiko.service-worker-update-reload-pending")).toBe(
      "true",
    );
  });

  it("does not ask a waiting worker to activate on first install without a controller", async () => {
    const postMessage = vi.fn();
    const registrationAddEventListener = vi.fn();
    const registration = {
      waiting: { postMessage } as unknown as ServiceWorker,
      installing: null,
      addEventListener: registrationAddEventListener,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    installServiceWorker({ controller: null, register });

    registerSw();

    await flushMicrotasks();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("clears the pending reload marker when update activation cannot be messaged", async () => {
    const postMessage = vi.fn().mockImplementation(() => {
      throw new Error("worker is no longer available");
    });
    const registrationAddEventListener = vi.fn();
    const registration = {
      waiting: { postMessage } as unknown as ServiceWorker,
      installing: null,
      addEventListener: registrationAddEventListener,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    installServiceWorker({ controller: {} as ServiceWorker, register });

    registerSw();

    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem("keiko.service-worker-update-reload-pending")).toBeNull();
  });

  it("asks a newly installed update to activate when an old controller is active", async () => {
    const postMessage = vi.fn();
    const waiting = { postMessage } as unknown as ServiceWorker;
    const installingAddEventListener = vi.fn();
    const installing = {
      state: "installing",
      addEventListener: installingAddEventListener,
    } as unknown as ServiceWorker;
    const registrationAddEventListener = vi.fn();
    const registration = {
      waiting,
      installing,
      addEventListener: registrationAddEventListener,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    installServiceWorker({ controller: {} as ServiceWorker, register });

    registerSw();

    await flushMicrotasks();
    const updateFoundHandler = registrationAddEventListener.mock.calls.find(
      ([event]) => event === "updatefound",
    )?.[1] as (() => void) | undefined;

    postMessage.mockClear();
    updateFoundHandler?.();
    const stateChangeHandler = installingAddEventListener.mock.calls.find(
      ([event]) => event === "statechange",
    )?.[1] as (() => void) | undefined;
    Object.defineProperty(installing, "state", { value: "installed" });
    stateChangeHandler?.();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: "KEIKO_ACTIVATE_WAITING_SERVICE_WORKER",
    });
  });

  it("reloads at most once when the activated update becomes the controller", async () => {
    const registrationAddEventListener = vi.fn();
    const registration = {
      waiting: null,
      installing: null,
      addEventListener: registrationAddEventListener,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    const addEventListener = vi.fn();
    installServiceWorker({ addEventListener, controller: {} as ServiceWorker, register });

    registerSw();

    await flushMicrotasks();
    window.sessionStorage.setItem("keiko.service-worker-update-reload-pending", "true");
    const controllerChangeHandler = addEventListener.mock.calls.find(
      ([event]) => event === "controllerchange",
    )?.[1] as (() => void) | undefined;

    controllerChangeHandler?.();
    controllerChangeHandler?.();

    expect(window.sessionStorage.getItem("keiko.service-worker-update-reload-pending")).toBeNull();
  });

  it("unregisters service workers instead of registering them in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    const register = vi.fn().mockResolvedValue({});
    installServiceWorker({ controller: null, getRegistrations, register });

    registerSw();

    await flushMicrotasks();

    expect(register).not.toHaveBeenCalled();
    expect(getRegistrations).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("removes only Keiko shell caches during development cleanup", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const getRegistrations = vi.fn().mockResolvedValue([]);
    const register = vi.fn().mockResolvedValue({});
    const keys = vi.fn().mockResolvedValue(["keiko-shell-v1", "images", "keiko-shell-v2"]);
    const deleteCache = vi.fn().mockResolvedValue(true);
    installServiceWorker({ controller: null, getRegistrations, register });
    installCaches({ keys, delete: deleteCache });

    registerSw();

    await flushMicrotasks();

    expect(register).not.toHaveBeenCalled();
    expect(keys).toHaveBeenCalledOnce();
    expect(deleteCache.mock.calls).toEqual([["keiko-shell-v1"], ["keiko-shell-v2"]]);
  });

  it("does not throw when development cleanup cannot enumerate registrations", () => {
    vi.stubEnv("NODE_ENV", "development");
    const getRegistrations = vi.fn().mockImplementation(() => {
      throw new Error("blocked by browser policy");
    });
    const register = vi.fn().mockResolvedValue({});
    installServiceWorker({ controller: null, getRegistrations, register });

    expect(() => {
      registerSw();
    }).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
});
