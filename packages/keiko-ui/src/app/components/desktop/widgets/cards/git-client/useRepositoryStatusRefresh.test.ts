// U-35 (#4491): the Git window converges to a repository changed by an IDE, a terminal or another
// Git client. Focus and visibility re-read once (debounced); while the document is visible a
// backed-off probe re-reads only when the status differs; a hidden document is never polled and
// two probes never overlap.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { GitRepositoryStatusResponse } from "@/lib/types";
import {
  AMBIENT_BASE_INTERVAL_MS,
  AMBIENT_FOCUS_DEBOUNCE_MS,
  AMBIENT_MAX_INTERVAL_MS,
  statusFingerprintDiffers,
  useRepositoryStatusRefresh,
} from "./useRepositoryStatusRefresh";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

interface Harness {
  readonly refresh: Mock<() => void>;
  readonly probe: Mock<() => Promise<boolean>>;
  readonly busy: Mock<() => boolean>;
}

function mount(
  overrides: { path?: string | null; probe?: () => Promise<boolean>; busy?: () => boolean } = {},
): Harness {
  const refresh = vi.fn<() => void>();
  const probe = vi.fn<() => Promise<boolean>>(
    overrides.probe ?? (async (): Promise<boolean> => false),
  );
  const busy = vi.fn<() => boolean>(overrides.busy ?? ((): boolean => false));
  const path = overrides.path === undefined ? "/repos/alpha" : overrides.path;
  renderHook((): void =>
    useRepositoryStatusRefresh(path, undefined, refresh, { probe, isBusy: busy }),
  );
  return { refresh, probe, busy };
}

async function advance(ms: number): Promise<void> {
  await act(async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useRepositoryStatusRefresh ambient refresh (U-35)", () => {
  beforeEach((): void => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach((): void => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("re-reads once, debounced, when the window gains focus", async (): Promise<void> => {
    const { refresh } = mount();
    act((): void => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).not.toHaveBeenCalled();
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the document becomes visible and not when it becomes hidden", async (): Promise<void> => {
    const { refresh } = mount();
    act((): void => setVisibility("hidden"));
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(refresh).not.toHaveBeenCalled();
    act((): void => setVisibility("visible"));
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("probes on an interval and re-reads only when the probe reports a difference", async (): Promise<void> => {
    let changed = false;
    const { refresh, probe } = mount({ probe: async () => changed });
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    changed = true;
    await advance(AMBIENT_BASE_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off while nothing changes, capped, and starts over after a change", async (): Promise<void> => {
    let changed = false;
    const { probe } = mount({ probe: async () => changed });
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    // The second wait is longer than the base interval.
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(AMBIENT_MAX_INTERVAL_MS * 10);
    const settled = probe.mock.calls.length;
    await advance(AMBIENT_MAX_INTERVAL_MS);
    expect(probe.mock.calls).toHaveLength(settled + 1);
    changed = true;
    await advance(AMBIENT_MAX_INTERVAL_MS);
    changed = false;
    const afterChange = probe.mock.calls.length;
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe.mock.calls).toHaveLength(afterChange + 1);
  });

  it("never polls a hidden document and resumes when it is visible again", async (): Promise<void> => {
    const { probe } = mount();
    act((): void => setVisibility("hidden"));
    await advance(AMBIENT_MAX_INTERVAL_MS * 3);
    expect(probe).not.toHaveBeenCalled();
    act((): void => setVisibility("visible"));
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never overlaps probes", async (): Promise<void> => {
    let release!: (changed: boolean) => void;
    const { probe } = mount({
      probe: () =>
        new Promise<boolean>((resolve): void => {
          release = resolve;
        }),
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 5);
    expect(probe).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      release(false);
      await Promise.resolve();
    });
    await advance(AMBIENT_MAX_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while a status read is already in flight", async (): Promise<void> => {
    const { probe, refresh } = mount({ busy: () => true });
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing without a selected repository", async (): Promise<void> => {
    const { probe, refresh } = mount({ path: null });
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps polling after a failed probe", async (): Promise<void> => {
    const probe = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error("offline"));
    probe.mockResolvedValue(false);
    const refresh = vi.fn<() => void>();
    renderHook(() =>
      useRepositoryStatusRefresh("/repos/alpha", undefined, refresh, {
        probe,
        isBusy: () => false,
      }),
    );
    await advance(AMBIENT_MAX_INTERVAL_MS * 4);
    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("statusFingerprintDiffers", () => {
  const base: GitRepositoryStatusResponse = {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    detached: false,
    clean: false,
    branch: "main",
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [
      {
        path: "scripts/gen.js",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
    ],
    truncated: false,
    maxChanges: 50,
  };

  it("is false for an equal status and true once the repository became clean", (): void => {
    expect(statusFingerprintDiffers(base, structuredClone(base))).toBe(false);
    expect(
      statusFingerprintDiffers(base, { ...base, clean: true, unstagedCount: 0, changes: [] }),
    ).toBe(true);
  });

  it("is false when there is no settled status to compare with", (): void => {
    expect(statusFingerprintDiffers(null, base)).toBe(false);
  });
});
