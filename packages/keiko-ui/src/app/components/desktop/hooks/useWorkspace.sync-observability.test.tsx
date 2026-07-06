/**
 * Workspace server-sync failure observability.
 *
 * Server sync failures were swallowed by bare `catch { return null; }` — network
 * errors, non-OK statuses and malformed payloads silently degraded the workspace to
 * localStorage-only persistence with no operator-visible signal. The transport must
 * surface ONE bounded, body-free console.warn per outage (re-armed by the next
 * successful exchange) and count every failure in a process-local counter, mirroring
 * the keepalive-overcap surface (GEN-PERF-PERSISTENCE-005) in the same module.
 */
import { useRef } from "react";
import type { ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readWorkspaceSyncFailureCount,
  resetWorkspaceSyncFailureSurface,
  useWorkspace,
} from "./useWorkspace";
import type { AppWindow } from "../windows/types";

const WS_LS = "keiko.workspace.v4";

function filesWindow(): AppWindow {
  return {
    id: "files-1",
    type: "files",
    x: 40,
    y: 40,
    w: 360,
    h: 320,
    z: 1,
    cfg: { root: "/repo" },
    max: false,
    zoom: 1,
  };
}

function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  useWorkspace(wsRef);
  return <main ref={wsRef} className="workspace" data-testid="ws" />;
}

function setWebdriver(value: boolean): void {
  Object.defineProperty(navigator, "webdriver", { configurable: true, value });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("workspace server-sync failure surfacing", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetWorkspaceSyncFailureSurface();
    setWebdriver(false); // enable server sync
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setWebdriver(true);
  });

  function syncWarnings(): string[] {
    return warnSpy.mock.calls
      .map((call: readonly unknown[]) => String(call[0]))
      .filter((message: string) => message.startsWith("workspace-state:"));
  }

  it("warns exactly once per outage across repeated pull failures, counting each", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, headers: new Headers() }) as Response),
    );

    render(<Harness />);
    await flush(); // initial pull fails → one warning

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100); // two more poll cycles fail
    });

    expect(readWorkspaceSyncFailureCount()).toBeGreaterThanOrEqual(3);
    expect(syncWarnings()).toHaveLength(1);
    expect(syncWarnings()[0]).toContain("status 500");
    // Body-free: the warning never carries snapshot contents.
    expect(syncWarnings()[0]).not.toContain("windows");
  });

  it("re-arms after a successful exchange so the next outage warns again", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failing
          ? ({ ok: false, status: 502, headers: new Headers() } as Response)
          : ({ ok: true, status: 304, headers: new Headers() } as Response),
      ),
    );

    render(<Harness />);
    await flush(); // outage #1 → warn
    failing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600); // recovery (304 counts as reachable)
    });
    failing = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600); // outage #2 → warn again
    });

    expect(syncWarnings()).toHaveLength(2);
  });

  it("surfaces a failing PUT without logging snapshot bodies", async () => {
    window.localStorage.setItem(WS_LS, JSON.stringify([filesWindow()]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") throw new TypeError("network down");
        return { ok: true, status: 304, headers: new Headers() } as Response;
      }),
    );

    render(<Harness />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400); // debounced PUT fires and rejects
    });
    await flush();

    const warnings = syncWarnings();
    expect(warnings.some((message) => message.includes("put failed (network error)"))).toBe(true);
    expect(warnings.every((message) => !message.includes("/repo"))).toBe(true);
    expect(readWorkspaceSyncFailureCount()).toBeGreaterThanOrEqual(1);
  });
});
