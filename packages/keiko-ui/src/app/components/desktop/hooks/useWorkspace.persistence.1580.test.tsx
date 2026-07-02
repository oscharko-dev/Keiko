/**
 * Issue #1580 — persistence/sync behaviour guards.
 *
 *  - the windows snapshot localStorage write is DEBOUNCED (a burst of mutations
 *    coalesces to one write) and FLUSHED on pagehide so nothing is lost on close;
 *  - the 1500ms server poll is VISIBILITY-GATED (no fetching in a hidden tab) and
 *    does an immediate catch-up pull on return to visible.
 */
import { useRef } from "react";
import type { ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import type { AppWindow } from "../windows/types";

const WS_LS = "keiko.workspace.v4";
const VIEW_LS = "keiko.view";
const POLL_MS = 1500;

function seedWindow(): AppWindow {
  return {
    id: "agents-1",
    type: "agents",
    x: 40,
    y: 40,
    w: 360,
    h: 320,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
  };
}

function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef);
  return (
    <main ref={wsRef} className="workspace" data-testid="ws">
      <button type="button" data-testid="minimize" onClick={() => ws.api.minimize("agents-1")}>
        minimize
      </button>
      <button type="button" data-testid="pan" onClick={() => ws.api.panBy(10, 20)}>
        pan
      </button>
    </main>
  );
}

function setWebdriver(value: boolean): void {
  Object.defineProperty(navigator, "webdriver", { configurable: true, value });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("Issue #1580 — debounced workspace persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    setWebdriver(true); // disable server sync for the localStorage-only assertions
    setHidden(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("debounces the windows write and flushes it on pagehide", () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    const { getByTestId } = render(<Harness />);
    // Let hydrate's initial debounced write settle, then start from a known value.
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    const baseline = window.localStorage.getItem(WS_LS);
    expect(baseline).not.toBeNull();

    // Mutate (minimize) — the write must NOT land synchronously.
    act(() => {
      getByTestId("minimize").click();
    });
    expect(window.localStorage.getItem(WS_LS)).toBe(baseline);

    // pagehide forces the pending write out immediately, before the debounce delay.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const flushed = window.localStorage.getItem(WS_LS);
    expect(flushed).not.toBe(baseline);
    expect(flushed).toContain('"minimized":true');
  });

  it("coalesces a burst of mutations into a single debounced write", () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    const { getByTestId } = render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      getByTestId("minimize").click();
      getByTestId("minimize").click();
      getByTestId("minimize").click();
    });
    const synchronousWsWrites = setItemSpy.mock.calls.filter(([key]) => key === WS_LS).length;
    expect(synchronousWsWrites).toBe(0);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    const debouncedWsWrites = setItemSpy.mock.calls.filter(([key]) => key === WS_LS).length;
    expect(debouncedWsWrites).toBe(1);
    setItemSpy.mockRestore();
  });

  it("debounces the view write and flushes it on pagehide", () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    window.localStorage.setItem(VIEW_LS, JSON.stringify({ x: 0, y: 0, zoom: 1 }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback): number => {
        callback(1);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { getByTestId } = render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    const baseline = window.localStorage.getItem(VIEW_LS);
    expect(JSON.parse(baseline ?? "null")).toEqual({ zoom: 1, x: 0, y: 0 });
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    act(() => {
      getByTestId("pan").click();
    });

    expect(window.localStorage.getItem(VIEW_LS)).toBe(baseline);
    expect(setItemSpy.mock.calls.filter(([key]) => key === VIEW_LS)).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(JSON.parse(window.localStorage.getItem(VIEW_LS) ?? "null")).toEqual({
      zoom: 1,
      x: 10,
      y: 20,
    });
    setItemSpy.mockRestore();
  });
});

describe("Issue #1580 — visibility-gated server poll", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    setWebdriver(false); // enable server sync
    setHidden(false);
    fetchMock = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () =>
          Promise.resolve({ workspace: { revision: 7, windows: [], connections: [] } }),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setWebdriver(true);
  });

  function getPolls(): number {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === undefined,
    ).length;
  }

  function pollHeaders(index: number): Record<string, string> {
    const calls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === undefined,
    );
    return ((calls[index]?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<
      string,
      string
    >;
  }

  async function flushAsyncEffects(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("stops polling while hidden and catches up on return to visible", async () => {
    render(<Harness />);
    await flushAsyncEffects();
    // initial mount pull
    const afterMount = getPolls();
    expect(afterMount).toBeGreaterThanOrEqual(1);
    expect(pollHeaders(0)["If-None-Match"]).toBe('"workspace-state-0"');

    // a poll interval fires while visible
    act(() => {
      vi.advanceTimersByTime(POLL_MS);
    });
    await flushAsyncEffects();
    expect(getPolls()).toBeGreaterThan(afterMount);
    expect(pollHeaders(getPolls() - 1)["If-None-Match"]).toBe('"workspace-state-7"');
    const beforeHidden = getPolls();

    // hide → the interval must stop: advancing time produces no new poll
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(POLL_MS * 3);
    });
    expect(getPolls()).toBe(beforeHidden);

    // visible again → one immediate catch-up pull
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(getPolls()).toBe(beforeHidden + 1);
  });
});
