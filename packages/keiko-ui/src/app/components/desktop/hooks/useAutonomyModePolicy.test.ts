import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMode, MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";

import { resetConversationMemorySettingsForTests } from "./memorySettings";
import { useAutonomyModePolicy, type AutonomyModePolicy } from "./useAutonomyModePolicy";

function policy(
  requestedMode: CodingWorkbenchMode,
  effectiveMode: CodingWorkbenchMode = requestedMode,
  deploymentCeiling: CodingWorkbenchMode = "autonomous-delivery",
): MemoryAutonomyPolicyWire {
  return { requestedMode, effectiveMode, deploymentCeiling };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle): void => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach((): void => {
  resetConversationMemorySettingsForTests();
});

describe("useAutonomyModePolicy", (): void => {
  it("hydrates and persists the server-confirmed requested and effective modes", async (): Promise<void> => {
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy("supervised-coding")),
    );
    const persist = vi.fn((mode: CodingWorkbenchMode): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy(mode)),
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
    expect(persist).toHaveBeenCalledWith("autonomous-delivery");
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

  it("ignores stale hydration after a newer persisted selection settles", async (): Promise<void> => {
    const hydration = deferred<MemoryAutonomyPolicyWire>();
    const load = vi.fn((): Promise<MemoryAutonomyPolicyWire> => hydration.promise);
    const persist = vi.fn((mode: CodingWorkbenchMode): Promise<MemoryAutonomyPolicyWire> =>
      Promise.resolve(policy(mode)),
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
});
