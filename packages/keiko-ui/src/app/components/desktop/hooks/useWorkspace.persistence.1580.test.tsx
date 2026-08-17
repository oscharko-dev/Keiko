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
      <output data-testid="wins">{ws.wins?.map((win) => win.id).join(",") ?? "loading"}</output>
      <output data-testid="view">
        {JSON.stringify({ zoom: ws.view.zoom, x: ws.view.x, y: ws.view.y })}
      </output>
      <button type="button" data-testid="minimize" onClick={() => ws.api.minimize("agents-1")}>
        minimize
      </button>
      <button type="button" data-testid="restore" onClick={() => ws.api.restore("agents-1")}>
        restore
      </button>
      <button type="button" data-testid="add" onClick={() => ws.api.add("agents")}>
        add
      </button>
      <button
        type="button"
        data-testid="close-last"
        onClick={() => {
          const last = ws.wins?.at(-1);
          if (last !== undefined) ws.api.close(last.id);
        }}
      >
        close last
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

function trackLocalStorageWrites(): {
  readonly keys: readonly string[];
  readonly restore: () => void;
} {
  const originalStorage = window.localStorage;
  const keys: string[] = [];
  const trackedStorage = new Proxy(originalStorage, {
    get(target, prop, receiver) {
      if (prop === "setItem") {
        return (key: string, value: string): void => {
          keys.push(key);
          target.setItem(key, value);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(window, "localStorage", { configurable: true, value: trackedStorage });
  return {
    keys,
    restore: () => {
      Object.defineProperty(window, "localStorage", { configurable: true, value: originalStorage });
    },
  };
}

async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimersUntil(predicate: () => boolean): Promise<void> {
  for (let elapsedMs = 0; elapsedMs <= 1_000; elapsedMs += 25) {
    await flushAsyncEffects();
    if (predicate()) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
  }
  expect(predicate()).toBe(true);
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

  it("debounces the windows write and flushes it on pagehide", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    const { getByTestId } = render(<Harness />);
    // Let hydrate's initial debounced write settle, then start from a known value.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
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

  it("coalesces a burst of mutations into a single debounced write", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    const { getByTestId } = render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    const baseline = window.localStorage.getItem(WS_LS);
    expect(baseline).toBe(JSON.stringify([seedWindow()]));
    const storageWrites = trackLocalStorageWrites();

    try {
      act(() => {
        getByTestId("minimize").click();
        getByTestId("minimize").click();
        getByTestId("minimize").click();
      });
      expect(window.localStorage.getItem(WS_LS)).toBe(baseline);
      expect(storageWrites.keys.filter((key) => key === WS_LS)).toHaveLength(0);

      await advanceTimersUntil(() => window.localStorage.getItem(WS_LS) !== baseline);
      const flushed = window.localStorage.getItem(WS_LS);
      expect(flushed).not.toBe(baseline);
      expect(flushed).toContain('"minimized":true');
      expect(storageWrites.keys.filter((key) => key === WS_LS)).toHaveLength(1);
    } finally {
      storageWrites.restore();
    }
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
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

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

  it("clamps invalid persisted view state on hydrate", () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    window.localStorage.setItem(VIEW_LS, JSON.stringify({ x: Number.NaN, y: Infinity, zoom: 99 }));

    const { getByTestId } = render(<Harness />);

    expect(JSON.parse(getByTestId("view").textContent ?? "null")).toEqual({
      zoom: 2.5,
      x: 0,
      y: 0,
    });
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

  function putCalls(): [unknown, RequestInit | undefined][] {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    ) as [unknown, RequestInit | undefined][];
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

  it("sends workspace PUTs with If-Match and skips a no-op keepalive flush", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-1"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 1, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();

    expect(putCalls()).toHaveLength(1);
    expect((putCalls()[0]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-0"',
    );

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await flushAsyncEffects();
    expect(putCalls()).toHaveLength(1);
  });

  it("re-sends a dirty snapshot after a 412 with the adopted revision", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let putAttempts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putAttempts += 1;
        if (putAttempts === 1) {
          return {
            ok: false,
            status: 412,
            headers: new Headers({ ETag: '"workspace-state-7"' }),
            json: async () => Promise.resolve({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-8"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 8, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    expect(putCalls()).toHaveLength(1);

    // The conflict must schedule ONE retry of the still-dirty snapshot with the adopted
    // revision — previously the snapshot was parked until the next local mutation, losing
    // e.g. a window close made before revision convergence (zombie window).
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    expect(putCalls()).toHaveLength(2);
    expect((putCalls()[1]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-7"',
    );
    expect(String(putCalls()[1]?.[1]?.body)).toContain("agents-1");

    // Converged: no further retry loop.
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    await flushAsyncEffects();
    expect(putCalls()).toHaveLength(2);
  });

  it("retries when the poll adopted the conflict's revision while the PUT was in flight", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let resolveFirstPoll: ((response: Response) => void) | undefined;
    let resolveFirstPut: ((response: Response) => void) | undefined;
    let puts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstPut = resolve;
          });
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-8"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 8, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      if (resolveFirstPoll === undefined) {
        return new Promise<Response>((resolve) => {
          resolveFirstPoll = resolve;
        });
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    // The debounced PUT fires FIRST (poll still pending) and carries revision 0.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    expect(puts).toBe(1);
    // Pin the race setup itself: the first PUT went out with the pristine revision 0 and the
    // mount poll is genuinely in flight — otherwise the retry would fire under `>` too and
    // this test would stop discriminating the equal-revision branch.
    expect((putCalls()[0]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-0"',
    );
    expect(resolveFirstPoll).toBeDefined();

    // The poll lands while the PUT is in flight and adopts revision 7 (dirty branch).
    resolveFirstPoll?.({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: '"workspace-state-7"' }),
      json: async () =>
        Promise.resolve({
          workspace: {
            revision: 7,
            windows: [
              {
                id: "foreign-1",
                type: "files",
                x: 1,
                y: 2,
                w: 320,
                h: 240,
                z: 9,
                cfg: {},
                max: false,
              },
            ],
            connections: [],
          },
        }),
    } as unknown as Response);
    await flushAsyncEffects();

    // NOW the stale PUT resolves as a conflict carrying the SAME revision 7: the retry must
    // still fire — an equal revision means "current If-Match would succeed", and parking the
    // dirty snapshot here recreates the zombie-window loss in the race window.
    resolveFirstPut?.({
      ok: false,
      status: 412,
      headers: new Headers({ ETag: '"workspace-state-7"' }),
      json: async () => Promise.resolve({}),
    } as unknown as Response);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();

    expect(puts).toBe(2);
    expect((putCalls()[1]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-7"',
    );
  });

  it("retries a conflict whose ETag is STALER than the poll-adopted revision", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let resolveFirstPoll: ((response: Response) => void) | undefined;
    let resolveFirstPut: ((response: Response) => void) | undefined;
    let puts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstPut = resolve;
          });
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-9"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 9, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      if (resolveFirstPoll === undefined) {
        return new Promise<Response>((resolve) => {
          resolveFirstPoll = resolve;
        });
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    expect(puts).toBe(1);
    expect(resolveFirstPoll).toBeDefined();

    // The poll advances PAST the conflict's revision while the PUT is in flight.
    resolveFirstPoll?.({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: '"workspace-state-8"' }),
      json: async () =>
        Promise.resolve({
          workspace: {
            revision: 8,
            windows: [
              {
                id: "foreign-1",
                type: "files",
                x: 1,
                y: 2,
                w: 320,
                h: 240,
                z: 9,
                cfg: {},
                max: false,
              },
            ],
            connections: [],
          },
        }),
    } as unknown as Response);
    await flushAsyncEffects();

    // The delayed conflict carries the OLDER revision 7: the bounded retry must still fire,
    // sending with the freshest adopted revision — otherwise the dirty close is parked and
    // resurrected on reload (the zombie window through the delayed-response window).
    resolveFirstPut?.({
      ok: false,
      status: 412,
      headers: new Headers({ ETag: '"workspace-state-7"' }),
      json: async () => Promise.resolve({}),
    } as unknown as Response);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();

    expect(puts).toBe(2);
    expect((putCalls()[1]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-8"',
    );
  });

  it("retries a conflict whose ETag a proxy stripped, using the poll-adopted revision", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let puts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) {
          // A 412 with NO ETag header — an intermediary stripped it.
          return {
            ok: false,
            status: 412,
            headers: new Headers(),
            json: async () => Promise.resolve({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-8"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 8, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ ETag: '"workspace-state-7"' }),
        json: async () =>
          Promise.resolve({
            workspace: {
              revision: 7,
              windows: [
                {
                  id: "foreign-1",
                  type: "files",
                  x: 1,
                  y: 2,
                  w: 320,
                  h: 240,
                  z: 9,
                  cfg: {},
                  max: false,
                },
              ],
              connections: [],
            },
          }),
      } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();

    // The ETag-less conflict still gets its bounded retry, and the retry carries the revision
    // the dirty poll branch adopted in the meantime — without it the snapshot stays parked
    // until the next local mutation.
    expect(puts).toBe(2);
    expect((putCalls()[1]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-7"',
    );
  });

  it("caps the conflict retry at one attempt per dirty snapshot", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let revision = 7;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        // A concurrent writer keeps advancing the revision: every PUT conflicts with a
        // strictly higher ETag. Without the per-snapshot cap this chains retries forever.
        revision += 1;
        return {
          ok: false,
          status: 412,
          headers: new Headers({ ETag: `"workspace-state-${String(revision)}"` }),
          json: async () => Promise.resolve({}),
        } as unknown as Response;
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    render(<Harness />);
    await flushAsyncEffects();
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        vi.advanceTimersByTime(400);
      });
      await flushAsyncEffects();
    }

    // Initial PUT + exactly ONE conflict retry for this snapshot — never a chain.
    expect(putCalls()).toHaveLength(2);
  });

  it("suppresses the conflict retry after the sync hook unmounted", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let resolvePut: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolvePut = resolve;
        });
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    const { unmount } = render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();
    expect(putCalls()).toHaveLength(1);
    expect(resolvePut).toBeDefined();

    // Unmount with the PUT still in flight, THEN let it resolve as a conflict: the retry
    // must not re-arm the debounce — a late PUT would overwrite the next shell's state.
    unmount();
    resolvePut?.({
      ok: false,
      status: 412,
      headers: new Headers({ ETag: '"workspace-state-9"' }),
      json: async () => Promise.resolve({}),
    } as unknown as Response);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    await flushAsyncEffects();

    expect(putCalls()).toHaveLength(1);
  });

  it("re-arms the conflict retry after an acknowledged save of the same serialization", async () => {
    // The EMPTY workspace is the serialization that genuinely recurs in production: it comes
    // back byte-identical every time the last window closes. A retry marker that survives an
    // acknowledged save would park exactly that close — the customer-visible zombie window.
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    let revision = 7;
    let puts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        revision += 1;
        if (puts === 2 || puts === 5) {
          return {
            ok: false,
            status: 412,
            headers: new Headers({ ETag: `"workspace-state-${String(revision)}"` }),
            json: async () => Promise.resolve({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: `"workspace-state-${String(revision)}"` }),
          json: async () =>
            Promise.resolve({ workspace: { revision, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      return { status: 304, ok: true, headers: new Headers() } as unknown as Response;
    });

    const { getByTestId } = render(<Harness />);
    await flushAsyncEffects();
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        act(() => {
          vi.advanceTimersByTime(400);
        });
        await flushAsyncEffects();
      }
    };

    // PUT 1: the hydrated window is acknowledged.
    await settle();
    expect(putCalls()).toHaveLength(1);

    // Close the only window: PUT 2 (empty) conflicts, PUT 3 retries it and is acknowledged —
    // the acknowledged save must re-arm the one-retry cap for the empty serialization.
    act(() => {
      getByTestId("close-last").click();
    });
    await settle();
    expect(putCalls()).toHaveLength(3);

    // Open another window (PUT 4 acknowledged), then close it again: the byte-identical
    // empty serialization conflicts a second time (PUT 5) — its retry (PUT 6) must fire.
    act(() => {
      getByTestId("add").click();
    });
    await settle();
    act(() => {
      getByTestId("close-last").click();
    });
    await settle();

    expect(putCalls()).toHaveLength(6);
    expect(String(putCalls().at(-1)?.[1]?.body)).toContain('"windows":[]');
  });

  it("adopts the polled server revision while dirty so the first PUT is not stale", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ ETag: '"workspace-state-8"' }),
          json: async () =>
            Promise.resolve({ workspace: { revision: 8, windows: [], connections: [] } }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ ETag: '"workspace-state-7"' }),
        json: async () =>
          Promise.resolve({
            workspace: {
              revision: 7,
              windows: [
                {
                  id: "foreign-1",
                  type: "files",
                  x: 1,
                  y: 2,
                  w: 320,
                  h: 240,
                  z: 9,
                  cfg: {},
                  max: false,
                },
              ],
              connections: [],
            },
          }),
      } as unknown as Response;
    });

    const { getByTestId } = render(<Harness />);
    await flushAsyncEffects();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flushAsyncEffects();

    // Local windows stay authoritative, but the first debounced PUT must already carry the
    // adopted server revision instead of the guaranteed-stale revision 0 (the deterministic
    // 412 the customer saw in the console on every reload with restored windows).
    expect(getByTestId("wins")).toHaveTextContent("agents-1");
    expect(putCalls().length).toBeGreaterThanOrEqual(1);
    expect((putCalls()[0]?.[1]?.headers as Record<string, string>)["If-Match"]).toBe(
      '"workspace-state-7"',
    );
  });

  it("does not apply a polled server snapshot over a locally dirty workspace", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([seedWindow()]));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ ETag: '"workspace-state-7"' }),
      json: async () =>
        Promise.resolve({
          workspace: {
            revision: 7,
            windows: [
              {
                id: "foreign-1",
                type: "files",
                x: 1,
                y: 2,
                w: 320,
                h: 240,
                z: 9,
                cfg: {},
                max: false,
              },
            ],
            connections: [],
          },
        }),
    } as unknown as Response);

    const { getByTestId } = render(<Harness />);
    await flushAsyncEffects();

    expect(getByTestId("wins")).toHaveTextContent("agents-1");
    expect(getByTestId("wins")).not.toHaveTextContent("foreign-1");
  });
});
