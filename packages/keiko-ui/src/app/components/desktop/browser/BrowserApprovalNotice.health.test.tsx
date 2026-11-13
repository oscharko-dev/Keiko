// #4370: the restart notice against the real health reader. Only the network is replaced: a real
// server answers /api/health with its diagnostics block, and the identity must survive it for the
// notice to recognize a restart at all.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { resetServerRestartStorageReport } from "@/lib/server-restart";
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

describe("restart notice through the real health reader (#4370)", () => {
  it("says Keiko was restarted when the instance changed while the session was lost", async () => {
    render(<BrowserApprovalNotice />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
    instanceId = AFTER;
    await loseSession();
    expect(await screen.findByText(/Keiko was restarted/u)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Connect browser" })).toHaveLength(1);
  });

  it("keeps the ordinary wording when the same server instance lost the session", async () => {
    render(<BrowserApprovalNotice />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await loseSession();
    expect(
      await screen.findByText("Keiko opens a connected window in this browser."),
    ).toBeVisible();
    expect(screen.queryByText(/Keiko was restarted/u)).toBeNull();
  });
});
