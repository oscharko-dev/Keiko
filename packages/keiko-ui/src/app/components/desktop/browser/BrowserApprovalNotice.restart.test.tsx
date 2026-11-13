import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import * as api from "@/lib/browser-approval-api";
import * as restart from "@/lib/server-restart";
import { codingAppSessionPairingSettled } from "@/lib/coding-app-session-client";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { openLauncherBrowser } from "@/lib/launcher-browser-client";
import { BrowserApprovalNotice } from "./BrowserApprovalNotice";

vi.mock("@/lib/launcher-browser-client", () => ({ openLauncherBrowser: vi.fn() }));
vi.mock("@/lib/browser-approval-api", () => ({
  inspectBrowserApprovals: vi.fn(),
  approveBrowserRequest: vi.fn(),
  revokeBrowserApproval: vi.fn(),
  requestBrowserApproval: vi.fn(),
  requestBrowserChallenge: vi.fn(),
  proveBrowserApproval: vi.fn(),
}));
vi.mock("@/lib/coding-app-session-client", async (original) => ({
  ...(await original<typeof import("@/lib/coding-app-session-client")>()),
  codingAppSessionPairingSettled: vi.fn(),
}));
vi.mock("@/lib/server-restart", () => ({
  noteConnectedServerInstance: vi.fn(),
  sessionEndedByRestart: vi.fn(),
}));

let active = false;

function inspection(): BrowserApprovalManagementResult {
  return active ? { state: "active", requests: [], approvals: [] } : { state: "unavailable" };
}

beforeEach(() => {
  vi.resetAllMocks();
  active = false;
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(false);
  vi.mocked(api.inspectBrowserApprovals).mockImplementation(async () => inspection());
  vi.mocked(restart.noteConnectedServerInstance).mockResolvedValue(undefined);
  vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(false);
  vi.mocked(openLauncherBrowser).mockImplementation(async () => {
    active = true;
  });
  setClientDiagnosticWriter(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetClientDiagnosticWriter();
  vi.restoreAllMocks();
});

const RESTARTED_MESSAGE =
  "Keiko was restarted, so this browser has to be connected again. One click on Connect browser does it. Your open chat and its draft are kept. A browser you remembered under Settings → Security → Browser approvals reconnects on its own.";

describe("after Keiko restarted (#4370)", () => {
  it("says in plain words that Keiko was restarted, without error styling", async () => {
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    render(<BrowserApprovalNotice />);
    const message = await screen.findByText(/Keiko was restarted/u);
    expect(message).toHaveTextContent(RESTARTED_MESSAGE);
    // An expected state: no alert role, one existing Connect control.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect browser" })).toHaveLength(1);
    expect(message.textContent).not.toMatch(/session|cookie|error|unauthor|registry/iu);
  });

  it("shows the restart in plain sight in the compact header, not only to assistive technology", async () => {
    // The shell renders the compact variant: its ordinary message stays visually hidden, but a restart
    // is a rare state the person must be able to read, with the full text kept as the tooltip.
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    render(<BrowserApprovalNotice compact />);
    const visible = await screen.findByText(
      "Keiko was restarted. Connect again; your chat and draft are kept.",
    );
    expect(visible).not.toHaveClass("visually-hidden");
    expect(screen.getByRole("button", { name: "Connect browser" })).toHaveAttribute(
      "title",
      RESTARTED_MESSAGE,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the ordinary compact message visually hidden when no restart was observed", async () => {
    render(<BrowserApprovalNotice compact />);
    const hidden = await screen.findByText("Keiko opens a connected window in this browser.");
    expect(hidden).toHaveClass("visually-hidden");
  });

  it("offers no way to remember the browser here and starts no approval by itself", async () => {
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    render(<BrowserApprovalNotice />);
    await screen.findByText(/Keiko was restarted/u);
    expect(screen.queryByRole("checkbox")).toBeNull();
    screen.getByRole("button", { name: "Connect browser" }).click();
    await waitFor(() => expect(openLauncherBrowser).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull(),
    );
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
    expect(api.approveBrowserRequest).not.toHaveBeenCalled();
    expect(api.proveBrowserApproval).not.toHaveBeenCalled();
  });

  it("keeps the ordinary wording when no restart was observed", async () => {
    render(<BrowserApprovalNotice />);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(screen.queryByText(/Keiko was restarted/u)).toBeNull();
    expect(screen.getByText("Keiko opens a connected window in this browser.")).toBeVisible();
  });

  it("has no accessibility violations in the restart state", async () => {
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    const { container } = render(<BrowserApprovalNotice />);
    await screen.findByText(/Keiko was restarted/u);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("remembers the server instance only while the session is valid", async () => {
    active = true;
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(restart.noteConnectedServerInstance).toHaveBeenCalled());
    expect(restart.sessionEndedByRestart).not.toHaveBeenCalled();
  });

  it("keeps the remembered server instance current while the session stays connected", async () => {
    // A restart the session survives must not be blamed for a later, unrelated loss: the stored
    // identity follows the server for as long as the tab is connected, with no state change.
    vi.useFakeTimers();
    active = true;
    render(<BrowserApprovalNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = vi.mocked(restart.noteConnectedServerInstance).mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(vi.mocked(restart.noteConnectedServerInstance).mock.calls.length).toBeGreaterThan(
      initial,
    );
    // The timer's tick asks the live session before it records; the first call, made right after
    // an active read, needs none (#4370).
    const calls = vi.mocked(restart.noteConnectedServerInstance).mock.calls;
    expect(calls[0]?.[0]).toBeUndefined();
    const confirm = calls.at(-1)?.[0];
    expect(typeof confirm).toBe("function");
    expect(await confirm?.()).toBe(true);
    active = false;
    expect(await confirm?.()).toBe(false);
    active = true;
    const afterFirst = vi.mocked(restart.noteConnectedServerInstance).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(restart.noteConnectedServerInstance).mock.calls.length).toBeGreaterThan(
      afterFirst,
    );
  });

  it("stops refreshing once the session is gone and then compares instead", async () => {
    vi.useFakeTimers();
    active = true;
    const view = render(<BrowserApprovalNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    active = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(restart.sessionEndedByRestart).toHaveBeenCalled();
    const calls = vi.mocked(restart.noteConnectedServerInstance).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(vi.mocked(restart.noteConnectedServerInstance).mock.calls.length).toBe(calls);
    view.unmount();
  });
});
