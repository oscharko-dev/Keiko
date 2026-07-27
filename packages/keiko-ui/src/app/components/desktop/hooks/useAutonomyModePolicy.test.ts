import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMode, MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";

import {
  currentConversationMemoryMode,
  resetConversationMemorySettingsForTests,
} from "./memorySettings";
import {
  resetAutonomyPersistenceQueueForTests,
  useAutonomyModePolicy,
  type AutonomyModePolicy,
} from "./useAutonomyModePolicy";

function policy(
  requestedMode: CodingWorkbenchMode,
  revision = 0,
  effectiveMode: CodingWorkbenchMode = requestedMode,
  deploymentCeiling: CodingWorkbenchMode = "autonomous-delivery",
): MemoryAutonomyPolicyWire {
  return { requestedMode, effectiveMode, deploymentCeiling, revision };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail): void => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach((): void => {
  resetAutonomyPersistenceQueueForTests();
  resetConversationMemorySettingsForTests();
});

describe("useAutonomyModePolicy", (): void => {
  it("hydrates and persists the server-confirmed requested and effective modes", async (): Promise<void> => {
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("supervised-coding", 7)),
    );
    const persist = vi.fn(
      (mode: CodingWorkbenchMode, expectedRevision: number): Promise<MemoryAutonomyPolicyWire> =>
        Promise.resolve(policy(mode, expectedRevision + 1)),
    );
    const view = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));

    await waitFor((): void => expect(view.result.current.pending).toBe(false));
    expect(view.result.current).toMatchObject({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      error: null,
    });

    act((): void => view.result.current.change("autonomous-delivery"));
    await waitFor((): void =>
      expect(view.result.current.effectiveMode).toBe("autonomous-delivery"),
    );
    expect(persist).toHaveBeenCalledWith("autonomous-delivery", 7, expect.any(AbortSignal));
    expect(view.result.current.requestedMode).toBe("autonomous-delivery");
  });

  it("surfaces failures without replacing the last server-confirmed mode", async (): Promise<void> => {
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("supervised-coding")),
    );
    const persist = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.reject(new Error("denied")),
    );
    const view = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change("autonomous-delivery"));
    await waitFor((): void => expect(view.result.current.error).toBe("persist"));

    expect(view.result.current.requestedMode).toBe("supervised-coding");
    expect(view.result.current.effectiveMode).toBe("supervised-coding");
    expect(view.result.current.pending).toBe(false);
  });

  it("surfaces hydration failures while retaining the fail-closed default", async (): Promise<void> => {
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.reject(new Error("unavailable")),
    );
    const view = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load }));

    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    expect(view.result.current.requestedMode).toBe("governed-assist");
    expect(view.result.current.effectiveMode).toBeNull();
    expect(view.result.current.error).toBe("hydrate");
  });

  it("ignores stale hydration after a newer persisted selection settles", async (): Promise<void> => {
    const hydration = deferred<MemoryAutonomyPolicyWire>();
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> => hydration.promise);
    const persist = vi.fn(
      (mode: CodingWorkbenchMode, expectedRevision: number): Promise<MemoryAutonomyPolicyWire> =>
        Promise.resolve(policy(mode, expectedRevision + 1)),
    );
    const view = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));

    act((): void => view.result.current.change("autonomous-delivery"));
    await waitFor((): void =>
      expect(view.result.current.effectiveMode).toBe("autonomous-delivery"),
    );
    await act(async (): Promise<void> => {
      hydration.resolve(policy("governed-assist"));
      await hydration.promise;
    });

    expect(view.result.current.requestedMode).toBe("autonomous-delivery");
    expect(view.result.current.effectiveMode).toBe("autonomous-delivery");
  });

  it("lets the latest persistence intent win across mounted settings surfaces", async (): Promise<void> => {
    const supervised = deferred<MemoryAutonomyPolicyWire>();
    const autonomous = deferred<MemoryAutonomyPolicyWire>();
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("governed-assist")),
    );
    const persist = vi.fn(
      (mode: CodingWorkbenchMode, _expectedRevision: number): Promise<MemoryAutonomyPolicyWire> =>
        mode === "supervised-coding" ? supervised.promise : autonomous.promise,
    );
    const first = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    const second = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    await waitFor((): void => expect(first.result.current.pending).toBe(false));
    await waitFor((): void => expect(second.result.current.pending).toBe(false));

    act((): void => first.result.current.change("supervised-coding"));
    act((): void => second.result.current.change("autonomous-delivery"));
    await waitFor((): void => expect(persist).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenNthCalledWith(1, "supervised-coding", 0, expect.any(AbortSignal));
    await act(async (): Promise<void> => {
      supervised.resolve(policy("supervised-coding", 1));
      await supervised.promise;
    });
    await waitFor((): void => expect(persist).toHaveBeenCalledTimes(2));
    expect(persist).toHaveBeenNthCalledWith(2, "autonomous-delivery", 1, expect.any(AbortSignal));
    await act(async (): Promise<void> => {
      autonomous.resolve(policy("autonomous-delivery", 2));
      await autonomous.promise;
    });

    expect(currentConversationMemoryMode()).toBe("autonomous-delivery");
    expect(first.result.current.requestedMode).toBe("autonomous-delivery");
    expect(second.result.current.requestedMode).toBe("autonomous-delivery");
  });

  it("retains an earlier server-confirmed mode when a newer cross-surface intent fails", async (): Promise<void> => {
    const supervised = deferred<MemoryAutonomyPolicyWire>();
    const autonomous = deferred<MemoryAutonomyPolicyWire>();
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("governed-assist")),
    );
    const persist = vi.fn(
      (mode: CodingWorkbenchMode, _expectedRevision: number): Promise<MemoryAutonomyPolicyWire> =>
        mode === "supervised-coding" ? supervised.promise : autonomous.promise,
    );
    const first = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    const second = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    await waitFor((): void => expect(first.result.current.pending).toBe(false));
    await waitFor((): void => expect(second.result.current.pending).toBe(false));

    act((): void => first.result.current.change("supervised-coding"));
    act((): void => second.result.current.change("autonomous-delivery"));
    await waitFor((): void => expect(persist).toHaveBeenCalledTimes(1));
    await act(async (): Promise<void> => {
      supervised.resolve(policy("supervised-coding", 1));
      await supervised.promise;
    });
    await waitFor((): void => expect(persist).toHaveBeenCalledTimes(2));
    await act(async (): Promise<void> => {
      autonomous.reject(new Error("denied"));
      await expect(autonomous.promise).rejects.toThrow("denied");
    });
    await waitFor((): void => expect(second.result.current.error).toBe("persist"));

    expect(currentConversationMemoryMode()).toBe("supervised-coding");
    expect(first.result.current.requestedMode).toBe("supervised-coding");
    expect(second.result.current.requestedMode).toBe("supervised-coding");
  });

  it("advances the intent queue when a persistence adapter ignores cancellation", async (): Promise<void> => {
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("governed-assist")),
    );
    const persist = vi.fn(
      (
        mode: CodingWorkbenchMode,
        _expectedRevision: number,
        _signal?: AbortSignal,
      ): Promise<MemoryAutonomyPolicyWire> =>
        mode === "supervised-coding"
          ? new Promise<MemoryAutonomyPolicyWire>(() => undefined)
          : Promise.resolve(policy(mode, 1)),
    );
    const view = renderHook((): AutonomyModePolicy =>
      useAutonomyModePolicy({ load, persist, persistTimeoutMs: 10 }),
    );
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change("supervised-coding"));
    act((): void => view.result.current.change("autonomous-delivery"));

    await waitFor((): void => expect(persist).toHaveBeenCalledTimes(2));
    await waitFor((): void => expect(view.result.current.pending).toBe(false));
    expect(view.result.current.requestedMode).toBe("autonomous-delivery");
    expect(view.result.current.error).toBeNull();
    expect(persist).toHaveBeenNthCalledWith(1, "supervised-coding", 0, expect.any(AbortSignal));
    expect(persist).toHaveBeenNthCalledWith(2, "autonomous-delivery", 0, expect.any(AbortSignal));
  });

  it("publishes a server-confirmed persistence result after the initiating surface unmounts", async (): Promise<void> => {
    const persistence = deferred<MemoryAutonomyPolicyWire>();
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("supervised-coding")),
    );
    const persist = vi.fn((): Promise<MemoryAutonomyPolicyWire> => persistence.promise);
    const view = renderHook((): AutonomyModePolicy => useAutonomyModePolicy({ load, persist }));
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change("autonomous-delivery"));
    view.unmount();
    await act(async (): Promise<void> => {
      persistence.resolve(policy("autonomous-delivery", 1));
      await persistence.promise;
    });

    await waitFor((): void => expect(currentConversationMemoryMode()).toBe("autonomous-delivery"));
  });
});
