import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import * as api from "@/lib/browser-approval-api";
import {
  codingAppSessionPairingSettled,
  ensureLocalCodingAppSession,
  useCodingAppSessionRedemptions,
  type CodingAppSessionPairingSeams,
} from "@/lib/coding-app-session-client";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { BrowserApprovalNotice } from "./BrowserApprovalNotice";
import { BrowserApprovalSettings } from "./BrowserApprovalSettings";

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

let active = true;
function inspection(): BrowserApprovalManagementResult {
  return active
    ? {
        state: "active",
        requests: [],
        approvals: [
          {
            approvalId: `bra_${"a".repeat(32)}`,
            remembered: true,
            approvedAtMs: 1_800_000_000_000,
            expiresAtMs: 1_800_003_600_000,
            lastUsedAtMs: 1_800_000_000_000,
            publicKeyFingerprint: "b".repeat(64),
          },
        ],
      }
    : { state: "unavailable" };
}

function repairSeams(post: () => Promise<unknown>): CodingAppSessionPairingSeams {
  return {
    readFragment: () => "",
    stripFragment: () => undefined,
    postPairing: async () => undefined,
    postLocalSession: post,
  };
}

function RefreshCounter(): ReactNode {
  return <output aria-label="Session refresh revision">{useCodingAppSessionRedemptions()}</output>;
}

beforeEach(() => {
  vi.resetAllMocks();
  active = true;
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(false);
  vi.mocked(api.inspectBrowserApprovals).mockImplementation(async () => inspection());
  vi.mocked(api.revokeBrowserApproval).mockImplementation(async () => {
    active = false;
    return { state: "accepted" };
  });
  setClientDiagnosticWriter(() => undefined);
});
afterEach(() => {
  cleanup();
  resetClientDiagnosticWriter();
});

describe("browser notice authentication lifecycle", () => {
  it("returns to the compact invoker after a pointer-opened dialog without granting authority", async () => {
    active = false;
    render(<BrowserApprovalNotice compact />);
    const connect = await screen.findByRole("button", { name: "Connect browser" });
    expect(document.body).toHaveFocus();
    fireEvent.click(connect);
    const dialog = screen.getByRole("dialog", { name: "Connect this browser" });
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByRole("button", { name: "Request approval" })).toBeEnabled();
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
    expect(api.approveBrowserRequest).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(connect).toHaveFocus());
  });

  it("keeps compact inventory retry read-only", async () => {
    active = false;
    vi.mocked(api.inspectBrowserApprovals).mockRejectedValueOnce(new TypeError("offline"));
    render(<BrowserApprovalNotice compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Connect browser" });
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
    expect(api.approveBrowserRequest).not.toHaveBeenCalled();
  });

  it("rechecks a local self-revocation without waiting for focus", async () => {
    render(
      <>
        <BrowserApprovalNotice />
        <BrowserApprovalSettings />
      </>,
    );
    const revoke = await screen.findByRole("button", { name: "Revoke approval" });
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
    fireEvent.click(revoke);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(api.revokeBrowserApproval).toHaveBeenCalledOnce();
    expect(vi.mocked(api.inspectBrowserApprovals).mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("inspects after a repair acknowledgement and never treats that acknowledgement as authority", async () => {
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    active = false;
    const post = vi.fn().mockResolvedValue({ schemaVersion: "1" });
    await act(async () => {
      expect(await ensureLocalCodingAppSession(repairSeams(post))).toBe(true);
    });
    await screen.findByRole("button", { name: "Connect browser" });
    expect(post).toHaveBeenCalledOnce();
  });

  it("also rechecks protected availability after a failed repair", async () => {
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    active = false;
    await act(async () => {
      expect(
        await ensureLocalCodingAppSession(
          repairSeams(async () => {
            throw new TypeError("offline");
          }),
        ),
      ).toBe(false);
    });
    await screen.findByRole("button", { name: "Connect browser" });
  });

  it("refreshes dependent readers after focus verifies a newly usable cookie, without a notification loop", async () => {
    active = false;
    render(
      <>
        <BrowserApprovalNotice />
        <RefreshCounter />
      </>,
    );
    await screen.findByRole("button", { name: "Connect browser" });
    const before = Number(screen.getByLabelText("Session refresh revision").textContent);
    active = true;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull(),
    );
    await waitFor(() =>
      expect(Number(screen.getByLabelText("Session refresh revision").textContent)).toBeGreaterThan(
        before,
      ),
    );
    const after = screen.getByLabelText("Session refresh revision").textContent;
    const reads = vi.mocked(api.inspectBrowserApprovals).mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(vi.mocked(api.inspectBrowserApprovals).mock.calls.length).toBeGreaterThan(reads),
    );
    expect(screen.getByLabelText("Session refresh revision").textContent).toBe(after);
  });

  it("ignores an obsolete active response delivered after a newer unavailable inspection", async () => {
    let deliver: ((value: BrowserApprovalManagementResult) => void) | undefined;
    const old = inspection();
    vi.mocked(api.inspectBrowserApprovals).mockImplementationOnce(
      () =>
        new Promise((resolve): void => {
          deliver = resolve;
        }),
    );
    active = false;
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(deliver).toBeDefined());
    fireEvent.focus(window);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(vi.mocked(api.inspectBrowserApprovals).mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => {
      deliver?.(old);
    });
    expect(screen.getByRole("button", { name: "Connect browser" })).toBeInTheDocument();
  });
});
