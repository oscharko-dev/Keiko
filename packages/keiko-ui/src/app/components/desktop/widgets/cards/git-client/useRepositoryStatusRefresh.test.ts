// U-35 (#4491): the Git window converges to a repository changed by an IDE, a terminal or another
// Git client. Focus, visibility and a backed-off interval all run ONE comparison of the fresh
// status with what is shown and re-read the window only when it differs, so an unchanged repository
// never invalidates the commit evidence or the diff. A hidden document or a minimized window is
// never polled, probes never overlap, and nothing runs mid-mutation.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { GitRepositoryStatusResponse } from "@/lib/types";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic }));

import {
  AMBIENT_BASE_INTERVAL_MS,
  AMBIENT_BUSY_RETRY_MS,
  AMBIENT_FOCUS_DEBOUNCE_MS,
  AMBIENT_MAX_INTERVAL_MS,
  REFRESH_COALESCE_MS,
  statusFingerprintDiffers,
  useRepositoryStatusRefresh,
} from "./useRepositoryStatusRefresh";

import { notifyGitRepositoryStateInvalidated } from "../git-repository-state-events";
import { notifyWorkspaceFileMutated } from "../workspace-file-events";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

interface Harness {
  readonly refresh: Mock<() => void>;
  readonly probe: Mock<() => Promise<boolean>>;
  readonly state: { busy: boolean; paused: boolean; changed: boolean };
  readonly restore: () => void;
  readonly unmount: () => void;
}

function mount(overrides: { path?: string | null; probe?: () => Promise<boolean> } = {}): Harness {
  const state = { busy: false, paused: false, changed: false };
  const refresh = vi.fn<() => void>();
  const probe = vi.fn<() => Promise<boolean>>(
    overrides.probe ?? (async (): Promise<boolean> => state.changed),
  );
  const path = overrides.path === undefined ? "/repos/alpha" : overrides.path;
  let onRendered: () => void = (): void => undefined;
  const { unmount } = renderHook((): void =>
    useRepositoryStatusRefresh(path, undefined, refresh, {
      probe,
      isBusy: (): boolean => state.busy,
      isPaused: (): boolean => state.paused,
      watchRendered: (callback): (() => void) => {
        onRendered = callback;
        return (): void => {
          onRendered = (): void => undefined;
        };
      },
    }),
  );
  return { refresh, probe, state, unmount, restore: (): void => onRendered() };
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
    reportClientDiagnostic.mockClear();
  });
  afterEach((): void => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("checks once, debounced, when the window gains focus and re-reads only on a difference", async (): Promise<void> => {
    const { refresh, probe, state } = mount();
    act((): void => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(probe).not.toHaveBeenCalled();
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    state.changed = true;
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("checks when the document becomes visible and not when it becomes hidden", async (): Promise<void> => {
    const { probe } = mount();
    act((): void => setVisibility("hidden"));
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(probe).not.toHaveBeenCalled();
    act((): void => setVisibility("visible"));
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-reads without a probe only when none is supplied", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    renderHook((): void => useRepositoryStatusRefresh("/repos/alpha", undefined, refresh));
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("probes on an interval and re-reads only when the probe reports a difference", async (): Promise<void> => {
    const { refresh, probe, state } = mount();
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    state.changed = true;
    await advance(AMBIENT_BASE_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off while nothing changes, capped, and starts over after a change", async (): Promise<void> => {
    const { probe, state } = mount();
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(AMBIENT_MAX_INTERVAL_MS * 10);
    const settled = probe.mock.calls.length;
    await advance(AMBIENT_MAX_INTERVAL_MS);
    expect(probe.mock.calls).toHaveLength(settled + 1);
    state.changed = true;
    await advance(AMBIENT_MAX_INTERVAL_MS);
    state.changed = false;
    const afterChange = probe.mock.calls.length;
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe.mock.calls).toHaveLength(afterChange + 1);
  });

  it("starts the backoff over when the window gains focus", async (): Promise<void> => {
    const { probe } = mount();
    await advance(AMBIENT_MAX_INTERVAL_MS * 10);
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS);
    const afterFocus = probe.mock.calls.length;
    // Without the reset the next probe would be a full minute away.
    await advance(AMBIENT_BASE_INTERVAL_MS * 2);
    expect(probe.mock.calls).toHaveLength(afterFocus + 1);
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

  it("never probes a window that is not rendered, such as a minimized one", async (): Promise<void> => {
    const { probe, state } = mount();
    state.paused = true;
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 3);
    expect(probe).not.toHaveBeenCalled();
    state.paused = false;
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("checks at once when a minimized window is restored, without waiting for the backoff", async (): Promise<void> => {
    const { probe, refresh, state, restore } = mount();
    await advance(AMBIENT_MAX_INTERVAL_MS * 10);
    const before = probe.mock.calls.length;
    state.changed = true;
    act((): void => restore());
    await advance(0);
    expect(probe.mock.calls).toHaveLength(before + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rechecks once the window is quiet when the probe answered while it became busy", async (): Promise<void> => {
    let release!: (changed: boolean) => void;
    const { probe, refresh, state } = mount({
      probe: () =>
        new Promise<boolean>((resolve): void => {
          release = resolve;
        }),
    });
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    state.busy = true;
    await act(async (): Promise<void> => {
      release(false);
      await Promise.resolve();
    });
    state.busy = false;
    await advance(AMBIENT_BUSY_RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await act(async (): Promise<void> => {
      release(true);
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("suppresses every probe while a read or mutation is running and retries a focus check once it settled", async (): Promise<void> => {
    const { probe, refresh, state } = mount();
    state.busy = true;
    state.changed = true;
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    state.busy = false;
    await advance(AMBIENT_BUSY_RETRY_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("reports a failed probe once per failure streak and again after a success", async (): Promise<void> => {
    let failing = true;
    const { probe } = mount({
      probe: async (): Promise<boolean> => {
        if (failing) throw new Error("offline");
        return false;
      },
    });
    await advance(AMBIENT_MAX_INTERVAL_MS * 6);
    expect(probe.mock.calls.length).toBeGreaterThan(2);
    expect(reportClientDiagnostic).toHaveBeenCalledTimes(1);
    failing = false;
    await advance(AMBIENT_MAX_INTERVAL_MS * 2);
    failing = true;
    await advance(AMBIENT_MAX_INTERVAL_MS * 4);
    expect(reportClientDiagnostic).toHaveBeenCalledTimes(2);
    const [message, meta] = reportClientDiagnostic.mock.calls[0] ?? [];
    expect(message).toBe("git-client: ambient status check failed");
    expect(JSON.stringify(meta)).not.toContain("offline");
  });

  it("leaves no timer and no listener behind after unmount", async (): Promise<void> => {
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const { unmount, probe } = mount();
    act((): void => {
      window.dispatchEvent(new Event("focus"));
    });
    unmount();
    const removed = [...windowRemove.mock.calls, ...documentRemove.mock.calls].map((call) =>
      String(call[0]),
    );
    expect(removed).toContain("focus");
    expect(removed).toContain("visibilitychange");
    expect(vi.getTimerCount()).toBe(0);
    await advance(AMBIENT_MAX_INTERVAL_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    windowRemove.mockRestore();
    documentRemove.mockRestore();
  });

  it("stops and starts over when the repository changes", async (): Promise<void> => {
    const probe = vi.fn<() => Promise<boolean>>(async (): Promise<boolean> => false);
    const { rerender } = renderHook(
      ({ path }: { readonly path: string }): void =>
        useRepositoryStatusRefresh(path, undefined, vi.fn(), { probe, isBusy: () => false }),
      { initialProps: { path: "/repos/alpha" } },
    );
    rerender({ path: "/repos/beta" });
    expect(vi.getTimerCount()).toBe(1);
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
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

// PERF-5 (#4491): one trigger is one refresh. Every listener funnels into one coalescer, so a burst
// (a restore that fires several signals, an event echoed by other windows) costs one leading and at
// most one trailing refresh, and a feedback loop cannot outrun the coalescing window.
describe("useRepositoryStatusRefresh coalescing (PERF-5)", () => {
  const ROOT = "/repos/alpha";
  const OTHER_ROOT = "/repos/beta";

  beforeEach((): void => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach((): void => {
    vi.useRealTimers();
  });

  function mountWith(
    refresh: () => void,
    ambient?: Parameters<typeof useRepositoryStatusRefresh>[3],
  ): () => void {
    const { unmount } = renderHook((): void =>
      useRepositoryStatusRefresh(ROOT, undefined, refresh, ambient),
    );
    return unmount;
  }

  function invalidate(root: string): void {
    notifyGitRepositoryStateInvalidated(root);
  }

  it("runs one leading and one trailing refresh for a burst of triggers", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    mountWith(refresh);
    act((): void => {
      invalidate(ROOT);
      notifyWorkspaceFileMutated(ROOT, { provenance: "agent" });
      invalidate(ROOT);
      invalidate(ROOT);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(REFRESH_COALESCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(AMBIENT_FOCUS_DEBOUNCE_MS * 4);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for an event naming another repository", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    mountWith(refresh);
    act((): void => {
      invalidate(OTHER_ROOT);
      notifyWorkspaceFileMutated(OTHER_ROOT, { provenance: "agent", repositoryRoot: OTHER_ROOT });
    });
    await advance(REFRESH_COALESCE_MS * 4);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("queues one trailing refresh for triggers that arrive while the previous cycle still runs", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    mountWith(refresh);
    act((): void => invalidate(ROOT));
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(REFRESH_COALESCE_MS / 3);
    act((): void => {
      invalidate(ROOT);
      invalidate(ROOT);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(REFRESH_COALESCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(REFRESH_COALESCE_MS * 4);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps a refresh that echoes its own invalidation to one cycle per coalescing window", async (): Promise<void> => {
    const LOOP_PERIOD_MS = 45;
    const WINDOW_MS = 3_000;
    const refresh = vi.fn<() => void>((): void => {
      setTimeout((): void => invalidate(ROOT), LOOP_PERIOD_MS);
    });
    mountWith(refresh);
    act((): void => invalidate(ROOT));
    await advance(WINDOW_MS);
    // Uncoalesced the loop would refresh WINDOW_MS / LOOP_PERIOD_MS (about 66) times.
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(WINDOW_MS / REFRESH_COALESCE_MS) + 1,
    );
    expect(refresh.mock.calls.length).toBeGreaterThan(1);
  });

  it("lets a refresh adopt the probe's status only when the probe was its sole trigger", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    const discardProbed = vi.fn<() => void>();
    const state = { changed: true };
    mountWith(refresh, {
      probe: async (): Promise<boolean> => state.changed,
      isBusy: (): boolean => false,
      discardProbed,
    });
    await advance(AMBIENT_BASE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(discardProbed).not.toHaveBeenCalled();
    await advance(REFRESH_COALESCE_MS);
    act((): void => invalidate(ROOT));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(discardProbed).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued trailing refresh on unmount", async (): Promise<void> => {
    const refresh = vi.fn<() => void>();
    const unmount = mountWith(refresh);
    act((): void => {
      invalidate(ROOT);
      invalidate(ROOT);
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(REFRESH_COALESCE_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
