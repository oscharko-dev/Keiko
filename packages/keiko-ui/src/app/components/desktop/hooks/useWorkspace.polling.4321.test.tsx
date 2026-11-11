import { useRef, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "@/lib/client-diagnostics";
import { useWorkspace } from "./useWorkspace";

function Harness(): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(ref);
  return (
    <main ref={ref}>
      <output data-testid="windows">{workspace.wins?.map(({ id }) => id).join(",")}</output>
      <button type="button" onClick={() => workspace.api.add("agents")}>
        add
      </button>
    </main>
  );
}

function visible(value: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: value ? "visible" : "hidden",
  });
}

function unchanged(): Response {
  return new Response(null, { status: 304 });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferredResponse(): {
  readonly response: Promise<Response>;
  readonly resolve: (value: Response) => void;
} {
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { response, resolve };
}

describe("workspace polling single-flight and idle cadence (#4321)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    visible(true);
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
    vi.spyOn(diagnostics, "reportClientDiagnostic").mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    visible(true);
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
  });

  it("skips timer ticks during a pull without aborting or overlapping it", async () => {
    const pending = deferredResponse();
    const signals: (AbortSignal | undefined | null)[] = [];
    let active = 0;
    let maximum = 0;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      active += 1;
      maximum = Math.max(maximum, active);
      return pending.response.finally(() => {
        active -= 1;
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<Harness />);
    await advance(6_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(maximum).toBe(1);
    expect(signals.every((signal) => signal?.aborted !== true)).toBe(true);
    expect(diagnostics.reportClientDiagnostic).toHaveBeenCalledWith(
      "Workspace polling deferred while a pull is pending.",
      { composerActivity: "workspace-sync-pull-pending" },
    );
    expect(
      vi
        .mocked(diagnostics.reportClientDiagnostic)
        .mock.calls.filter(([, meta]) => meta?.composerActivity === "workspace-sync-pull-pending"),
    ).toHaveLength(1);
    await act(async () => {
      pending.resolve(unchanged());
    });
    await advance(1_500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(1);
  });

  it("backs off successful unchanged clean pulls to a bounded six-second interval", async () => {
    const started: number[] = [];
    const origin = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started.push(Date.now() - origin);
        return Promise.resolve(unchanged());
      }),
    );
    render(<Harness />);
    await advance(10_500);
    expect(started).toEqual([0, 1_500, 4_500, 10_500]);
    await advance(6_000);
    expect(started.at(-1)).toBe(16_500);
  });

  it("resets the idle interval when a person changes the workspace", async () => {
    const started: number[] = [];
    const origin = Date.now();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT")
        return Promise.resolve(
          new Response(JSON.stringify({ workspace: { revision: 1 } }), { status: 200 }),
        );
      started.push(Date.now() - origin);
      return Promise.resolve(unchanged());
    });
    vi.stubGlobal("fetch", fetch);
    const screen = render(<Harness />);
    await advance(4_500);
    expect(started).toEqual([0, 1_500, 4_500]);
    act(() => {
      screen.getByRole("button", { name: "add" }).click();
    });
    await advance(1_500);
    expect(started.at(-1)).toBe(6_000);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(diagnostics.reportClientDiagnostic).toHaveBeenCalledWith(
      "Workspace polling resumed its active interval.",
      { composerActivity: "workspace-sync-active" },
    );
  });

  it("coalesces visibility catch-up during a pending pull into one trailing refresh", async () => {
    const pending = deferredResponse();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(pending.response)
      .mockImplementation(() => Promise.resolve(unchanged()));
    vi.stubGlobal("fetch", fetch);
    render(<Harness />);
    for (let index = 0; index < 2; index += 1) {
      act(() => {
        visible(false);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        visible(true);
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(unchanged());
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1_499);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not replay a pending visibility refresh after unmount", async () => {
    const pending = deferredResponse();
    const fetch = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetch);
    const screen = render(<Harness />);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    screen.unmount();
    await act(async () => {
      pending.resolve(unchanged());
    });
    await advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
