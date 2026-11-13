import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import * as api from "@/lib/browser-approval-api";
import * as approvalClient from "@/lib/browser-approval-client";
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
const rememberCurrent = vi.fn();

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
  vi.spyOn(approvalClient, "createLocalBrowserApprovalClient").mockReturnValue({
    begin: vi.fn(),
    complete: vi.fn(),
    restore: vi.fn(),
    rememberCurrent,
  });
  rememberCurrent.mockResolvedValue("stored");
  setClientDiagnosticWriter(() => undefined);
});
afterEach(() => {
  cleanup();
  resetClientDiagnosticWriter();
  vi.restoreAllMocks();
});

describe("after Keiko restarted (#4370)", () => {
  it("says in plain words that Keiko was restarted, without error styling", async () => {
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    render(<BrowserApprovalNotice />);
    const message = await screen.findByText(/Keiko was restarted/u);
    expect(message).toHaveTextContent(
      "Keiko was restarted, so this browser has to be connected again. One click on Connect browser does it. Your open chat and its draft are kept.",
    );
    // An expected state: no alert role, one existing Connect control.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect browser" })).toHaveLength(1);
    expect(message.textContent).not.toMatch(/session|cookie|error|unauthor|registry/iu);
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
});

describe("offering to remember this browser (#4370)", () => {
  it("is off by default, explains itself in one sentence and does not remember on a plain connect", async () => {
    render(<BrowserApprovalNotice />);
    const choice = await screen.findByRole("checkbox", { name: "Remember this browser" });
    expect(choice).not.toBeChecked();
    expect(choice).toHaveAccessibleDescription(
      "This browser then continues after a restart, for up to 30 days.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect browser" }));
    await waitFor(() => expect(openLauncherBrowser).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull(),
    );
    expect(rememberCurrent).not.toHaveBeenCalled();
  });

  it("remembers exactly once after the connection succeeds when the human chose it", async () => {
    render(<BrowserApprovalNotice />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remember this browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect browser" }));
    await waitFor(() => expect(rememberCurrent).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This browser stays connected after a restart, for up to 30 days.",
    );
    // Polling and focus refreshes after the connection never repeat the choice.
    fireEvent.focus(window);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalled());
    expect(rememberCurrent).toHaveBeenCalledOnce();
  });

  it.each(["unconfirmed", "unavailable"] as const)(
    "says plainly when remembering did not work (%s) and keeps the connection",
    async (outcome) => {
      rememberCurrent.mockResolvedValue(outcome);
      render(<BrowserApprovalNotice />);
      fireEvent.click(await screen.findByRole("checkbox", { name: "Remember this browser" }));
      fireEvent.click(screen.getByRole("button", { name: "Connect browser" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "This browser is connected, but it could not be remembered. After a restart, connect it again.",
      );
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
    },
  );

  it("treats a thrown failure as not remembered, records a diagnostic and never retries by itself", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    rememberCurrent.mockRejectedValue(new TypeError("storage blocked"));
    render(<BrowserApprovalNotice />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remember this browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect browser" }));
    expect(await screen.findByRole("status")).toHaveTextContent("could not be remembered");
    expect(rememberCurrent).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalled();
  });

  it("offers the same choice at the moment of a restart and has no accessibility violations", async () => {
    vi.mocked(restart.sessionEndedByRestart).mockResolvedValue(true);
    const { container } = render(<BrowserApprovalNotice />);
    await screen.findByText(/Keiko was restarted/u);
    expect(screen.getByRole("checkbox", { name: "Remember this browser" })).not.toBeChecked();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps the compact notice to its single existing control", async () => {
    render(<BrowserApprovalNotice compact />);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("does not offer the choice while the connection check itself failed", async () => {
    vi.mocked(api.inspectBrowserApprovals).mockRejectedValue(new TypeError("offline"));
    render(<BrowserApprovalNotice />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    await act(async () => undefined);
  });
});
