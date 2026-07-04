/**
 * STEP 07 cluster B — GEN-PERF-PERSISTENCE-005 (SEC).
 *
 * The final keepalive PUT on tab-hide must be guarded against the 64KiB fetch
 * keepalive body cap: an oversize body is rejected by the browser and the flush is
 * silently lost. When the serialized snapshot exceeds the keepalive budget the
 * transport must (a) drop keepalive and send a normal PUT instead, and (b) surface
 * the overcap via a process-local counter (not swallow it). The sanitize path that
 * drops data-URL/large payloads stays intact.
 */
import { useRef } from "react";
import type { ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keepaliveBodyFitsBudget,
  readWorkspaceKeepaliveOvercapCount,
  resetWorkspaceKeepaliveOvercapCount,
  useWorkspace,
  WORKSPACE_KEEPALIVE_BODY_BUDGET_BYTES,
} from "./useWorkspace";
import type { AppWindow } from "../windows/types";

const WS_LS = "keiko.workspace.v4";

// A durable, non-singleton window whose allowlisted labels survive sanitize and
// carry enough safe text to push the serialized body over the keepalive budget.
function heavyPreviewWindow(index: number): AppWindow {
  const label = `Document ${String(index)} ${"section ".repeat(30)}`.slice(0, 220);
  return {
    id: `pdf-${String(index)}`,
    type: "pdfCitationPreview",
    x: 40,
    y: 40,
    w: 480,
    h: 360,
    z: 1,
    max: false,
    cfg: {
      documentLabel: label,
      sourceLabel: label,
      pageLabel: label,
      failureMessage: label,
    },
  } as unknown as AppWindow;
}

function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  useWorkspace(wsRef);
  return <main ref={wsRef} className="workspace" data-testid="ws" />;
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

describe("keepaliveBodyFitsBudget (GEN-PERF-PERSISTENCE-005)", () => {
  it("accepts a small body and rejects a body over the budget", () => {
    expect(keepaliveBodyFitsBudget("small")).toBe(true);
    expect(keepaliveBodyFitsBudget("x".repeat(WORKSPACE_KEEPALIVE_BODY_BUDGET_BYTES + 1))).toBe(
      false,
    );
  });
});

describe("workspace keepalive flush over the 64KiB cap (GEN-PERF-PERSISTENCE-005)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetWorkspaceKeepaliveOvercapCount();
    setWebdriver(false); // enable server sync
    setHidden(false);
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setWebdriver(true);
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function keepalivePutCalls(): boolean[] {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
      .map(([, init]) => (init as RequestInit & { keepalive?: boolean }).keepalive === true);
  }

  it("falls back to a non-keepalive PUT and increments the overcap counter", async () => {
    const heavy = Array.from({ length: 128 }, (_, i) => heavyPreviewWindow(i));
    window.localStorage.setItem(WS_LS, JSON.stringify(heavy));

    render(<Harness />);
    await flush();

    // The tab hides mid-session → the keepalive flush path runs. Because the body is
    // over the keepalive budget the PUT must be sent WITHOUT keepalive, and the
    // overcap must be surfaced via the counter.
    act(() => {
      setHidden(true);
      window.dispatchEvent(new Event("pagehide"));
    });
    await flush();

    const puts = keepalivePutCalls();
    expect(puts.length).toBeGreaterThanOrEqual(1);
    // No PUT was sent with keepalive:true (the oversize body forced the fallback).
    expect(puts.every((keepalive) => keepalive === false)).toBe(true);
    expect(readWorkspaceKeepaliveOvercapCount()).toBeGreaterThanOrEqual(1);
  });
});
