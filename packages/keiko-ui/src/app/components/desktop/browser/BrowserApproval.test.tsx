import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { BrowserApprovalRequestDescriptor } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import * as api from "@/lib/browser-approval-api";
import {
  createLocalBrowserApprovalClient,
  type BrowserApprovalClient,
} from "@/lib/browser-approval-client";
import { BrowserApprovalSettings } from "./BrowserApprovalSettings";
import { BrowserApprovalDialog } from "./BrowserApprovalDialog";
import { createBrowserApprovalKey } from "@/lib/browser-approval-crypto";

const forgetKey = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/browser-approval-key-store", () => ({
  createBrowserApprovalKeyStore: vi.fn(() => ({ forget: forgetKey })),
}));

vi.mock("@/lib/browser-approval-api", () => ({
  inspectBrowserApprovals: vi.fn(),
  approveBrowserRequest: vi.fn(),
  revokeBrowserApproval: vi.fn(),
}));
vi.mock("@/lib/browser-approval-client", () => ({ createLocalBrowserApprovalClient: vi.fn() }));
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: vi.fn().mockResolvedValue(false),
  useCodingAppSessionRedemptions: (): number => 0,
  useCodingAppSessionChecks: (): number => 0,
  notifyCodingAppSessionChanged: vi.fn(),
}));

const REQUEST: BrowserApprovalRequestDescriptor = {
  requestId: `brq_${"a".repeat(32)}`,
  comparisonCode: "01234567",
  requestedAtMs: 1_800_000_000_000,
  expiresAtMs: 1_800_000_300_000,
  rememberRequested: true,
  publicKeyFingerprint: "b".repeat(64),
};

beforeEach(async () => {
  vi.resetAllMocks();
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", keys.privateKey.constructor);
  vi.mocked(api.inspectBrowserApprovals).mockResolvedValue({
    state: "active",
    requests: [REQUEST],
    approvals: [],
  });
  vi.mocked(api.approveBrowserRequest).mockResolvedValue({ state: "accepted" });
  vi.mocked(api.revokeBrowserApproval).mockResolvedValue({ state: "accepted" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser approval surfaces", () => {
  it("requires explicit comparison and allows a session-only downgrade of a remember request", async () => {
    render(<BrowserApprovalSettings />);
    const allow = await screen.findByRole("button", { name: "Allow this session" });
    expect(allow).toBeDisabled();
    expect(screen.getByLabelText("Browser comparison code")).toHaveTextContent(
      REQUEST.comparisonCode,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /I have compared/ }));
    fireEvent.click(allow);
    await waitFor(() =>
      expect(api.approveBrowserRequest).toHaveBeenCalledWith(
        {
          requestId: REQUEST.requestId,
          comparisonCode: REQUEST.comparisonCode,
          remember: false,
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not offer remembered approval when the requesting browser did not ask for it", async () => {
    vi.mocked(api.inspectBrowserApprovals).mockResolvedValue({
      state: "active",
      requests: [{ ...REQUEST, rememberRequested: false }],
      approvals: [],
    });
    render(<BrowserApprovalSettings />);
    await screen.findByRole("button", { name: "Allow this session" });
    expect(screen.queryByRole("button", { name: /Allow and remember/ })).toBeNull();
  });

  it("lists and revokes a session approval after the original request expires", async () => {
    const approvalId = `bra_${"c".repeat(32)}`;
    vi.mocked(api.inspectBrowserApprovals).mockResolvedValue({
      state: "active",
      requests: [],
      approvals: [
        {
          approvalId,
          remembered: false,
          approvedAtMs: REQUEST.requestedAtMs,
          expiresAtMs: REQUEST.expiresAtMs + 300_000,
          lastUsedAtMs: REQUEST.expiresAtMs,
          publicKeyFingerprint: REQUEST.publicKeyFingerprint,
        },
      ],
    });
    render(<BrowserApprovalSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke approval" }));
    await waitFor(() =>
      expect(api.revokeBrowserApproval).toHaveBeenCalledWith(approvalId, expect.any(AbortSignal)),
    );
    expect(screen.getByText("Session approval")).toBeInTheDocument();
  });

  it("defaults to session approval and reports unconfirmed persistence without a success claim", async () => {
    const key = await createBrowserApprovalKey();
    const client: BrowserApprovalClient = {
      begin: vi.fn().mockResolvedValue({ key, request: REQUEST, correlationId: "corr_ui" }),
      complete: vi.fn().mockResolvedValue({ state: "active", persistence: "unconfirmed" }),
      restore: vi.fn().mockResolvedValue(false),
    };
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(client);
    render(<BrowserApprovalDialog onClose={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Remember this browser/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Request approval" }));
    await screen.findByText(/Remembering it for future connections could not be confirmed/);
    expect(client.begin).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("cancels a removed requester and never completes its late request", async () => {
    const key = await createBrowserApprovalKey();
    let finish: ((value: Awaited<ReturnType<BrowserApprovalClient["begin"]>>) => void) | undefined;
    const client: BrowserApprovalClient = {
      begin: vi.fn().mockImplementation(
        () =>
          new Promise((resolve): void => {
            finish = resolve;
          }),
      ),
      complete: vi.fn(),
      restore: vi.fn().mockResolvedValue(false),
    };
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(client);
    const view = render(<BrowserApprovalDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Request approval" }));
    const signal = vi.mocked(client.begin).mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.({
        key,
        request: REQUEST,
        correlationId: "corr_late",
      });
    });
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("forgets a local connection only after its deletion commits and makes no revocation claim", async () => {
    let commit: (() => void) | undefined;
    forgetKey.mockImplementationOnce(
      () =>
        new Promise<void>((resolve): void => {
          commit = resolve;
        }),
    );
    render(<BrowserApprovalSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Forget this browser's remembered connection" }),
    );
    expect(screen.queryByText(/The remembered connection was removed/)).toBeNull();
    expect(forgetKey).toHaveBeenCalledOnce();
    await act(async () => {
      commit?.();
    });
    await screen.findByText(/The current session and server approval are unchanged/);
    expect(api.revokeBrowserApproval).not.toHaveBeenCalled();
  });
});
