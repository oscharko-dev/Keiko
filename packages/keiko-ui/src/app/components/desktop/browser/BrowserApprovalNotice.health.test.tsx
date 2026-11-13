// #4370: the restart notice against the real health reader. Only the network is replaced: a real
// server answers /api/health with its diagnostics block, and the identity must survive it for the
// notice to recognize a restart at all.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import {
  CONNECTED_SERVER_INSTANCE_STORAGE_KEY,
  resetServerRestartStorageReport,
} from "@/lib/server-restart";
import { BrowserApprovalNotice } from "./BrowserApprovalNotice";

const BEFORE = "a".repeat(32);
const AFTER = "b".repeat(32);

let connected = true;
let instanceId = BEFORE;

function health(): HealthResponse {
  return {
    status: "ok",
    version: "1.4.0",
    diagnostics: { readiness: "ready", reasons: [], writer: "production-file", lostEvents: 0 },
    memory: { readiness: "ready", reason: "none" },
    instanceId,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  connected = true;
  instanceId = BEFORE;
  window.sessionStorage.clear();
  resetServerRestartStorageReport();
  setClientDiagnosticWriter(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === "/api/health") return json(health());
      if (path === "/api/coding-workbench/app-session/browser")
        return json(
          connected ? { state: "active", requests: [], approvals: [] } : { state: "unavailable" },
        );
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
  resetClientDiagnosticWriter();
  window.sessionStorage.clear();
});

async function loseSession(): Promise<void> {
  connected = false;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

const remembered = (): string | null =>
  window.sessionStorage.getItem(CONNECTED_SERVER_INSTANCE_STORAGE_KEY);
/** The observable end of the initial identity write; no fixed sleep. */
const identityRemembered = (instance: string): Promise<void> =>
  waitFor(() => {
    expect(remembered()).toBe(instance);
  });
/**
 * The component's thirty-second refresh timer, captured instead of waited for. Every other interval
 * (testing-library's own polling) runs for real, so no fake clock is needed and nothing sleeps.
 */
function captureRefreshTimer(): { fire: () => void } {
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const captured: (() => void)[] = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== 30_000) return realSetInterval(handler, delay, ...rest);
    captured.push(handler);
    return 0;
  }) as typeof setInterval);
  return {
    fire: (): void => {
      const latest = captured.at(-1);
      if (latest === undefined) throw new Error("The refresh timer was never started");
      latest();
    },
  };
}
const healthReads = (): number =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/health")).length;

describe("restart notice through the real health reader (#4370)", () => {
  it("says Keiko was restarted when the instance changed while the session was lost", async () => {
    render(<BrowserApprovalNotice />);
    await identityRemembered(BEFORE);
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
    instanceId = AFTER;
    await loseSession();
    expect(await screen.findByText(/Keiko was restarted/u)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Connect browser" })).toHaveLength(1);
  });

  it("keeps the ordinary wording when the same server instance lost the session", async () => {
    render(<BrowserApprovalNotice />);
    await identityRemembered(BEFORE);
    await loseSession();
    expect(
      await screen.findByText("Keiko opens a connected window in this browser."),
    ).toBeVisible();
    expect(screen.queryByText(/Keiko was restarted/u)).toBeNull();
  });

  // The tab stays open across a restart and nothing re-inspects the session until focus or a check, so
  // the last inspection can still read "active". The refresh timer must not record the NEW process as
  // the one this tab was connected to; that would erase the evidence of the restart (#4370).
  it("does not record the new server instance while the session is already gone", async () => {
    const refresh = captureRefreshTimer();
    render(<BrowserApprovalNotice />);
    await identityRemembered(BEFORE);
    instanceId = AFTER;
    connected = false;
    const reads = healthReads();
    await act(async () => {
      refresh.fire();
    });
    await waitFor(() => {
      expect(healthReads()).toBeGreaterThan(reads);
    });
    for (let turn = 0; turn < 20; turn += 1) await act(async () => Promise.resolve());
    expect(remembered()).toBe(BEFORE);
    await loseSession();
    expect(await screen.findByText(/Keiko was restarted/u)).toBeVisible();
  });

  it("keeps refreshing the remembered instance while the session is confirmed active", async () => {
    const refresh = captureRefreshTimer();
    render(<BrowserApprovalNotice />);
    await identityRemembered(BEFORE);
    // A restart the session survived (a remembered browser renewed on its own): still active.
    instanceId = AFTER;
    await act(async () => {
      refresh.fire();
    });
    await identityRemembered(AFTER);
  });
});
