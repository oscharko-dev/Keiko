// F3 — CardHeader renders `new Date(connector.createdAt).toISOString().slice(0, 10)` directly
// against a field that comes straight off the BFF response with no runtime shape validation
// (`AtlassianConnectorMetadata.createdAt` is a compile-time-only `number`). Unlike
// `toLocaleString`, `Date#toISOString` throws `RangeError: Invalid time value` on an Invalid
// Date, and the `/atlassian-connectors` route has no error boundary anywhere above it — so one
// malformed persisted connector record white-screens the whole route. This test fails on the
// pre-fix component because mounting throws; after routing the value through the safe formatter
// it renders a fallback instead.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";
import { AtlassianConnectorsPanel } from "./AtlassianConnectorsPanel";

function hostileConnector(createdAt: unknown): AtlassianConnectorMetadata {
  return {
    schemaVersion: "1",
    authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
    provider: "confluence",
    displayName: "Docs",
    baseUrl: "https://x.atlassian.net",
    authScheme: "basic-api-token",
    createdAt: createdAt as number,
  };
}

function clientListing(connector: AtlassianConnectorMetadata): AtlassianConnectorsClient {
  return {
    listConnectors: vi.fn(async () => [connector]),
    createConnector: vi.fn(async () => connector),
    deleteConnector: vi.fn(async () => ({ ok: true as const })),
    verifyConnector: vi.fn(async () => ({ authRef: connector.authRef, status: "ok" as const })),
    startSync: vi.fn(async () => ({ job: { jobId: "j", status: "pending" } as never })),
    getSyncJob: vi.fn(async () => ({ job: { jobId: "j", status: "pending" } as never })),
    cancelSyncJob: vi.fn(async () => ({ job: { jobId: "j", status: "cancelled" } as never })),
    listActivity: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    getApproval: vi.fn(async () => ({}) as never),
    approveAction: vi.fn(async () => ({ disposition: "review-required" as const })),
    rejectAction: vi.fn(async () => ({
      approvalId: "x",
      disposition: "review-required" as const,
      outcome: "cancelled" as const,
    })),
  };
}

function validConnector(): AtlassianConnectorMetadata {
  return {
    schemaVersion: "1",
    authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
    provider: "confluence",
    displayName: "Docs",
    baseUrl: "https://x.atlassian.net",
    authScheme: "basic-api-token",
    createdAt: Date.UTC(2026, 0, 1),
  };
}

// KEIKO-0508: DeleteConfirm carried role="alertdialog" without any of the modality machinery the
// role promises: focus stayed on <body>, Escape did nothing, aria-label was a hardcoded slug the
// reader never sees. Mirror AgentGateCard's mount-focus + Escape handling and expose the confirm
// copy as the accessible name via aria-labelledby.
describe("ConnectorCard DeleteConfirm (KEIKO-0508)", () => {
  it("moves focus into the delete confirmation, uses the translated copy as its accessible name, and cancels on Escape", async () => {
    const user = userEvent.setup();
    const connector = validConnector();
    render(
      <AtlassianConnectorsPanel
        client={clientListing(connector)}
        pollIntervalMs={100000}
      />,
    );
    await screen.findByTestId("acx-connector");
    (document.activeElement as HTMLElement | null)?.blur?.();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete this connector? Its stored credential is removed.",
    });
    expect(confirm).not.toHaveAttribute("aria-label", "delete-connector");
    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: "Keep connector" })).toHaveFocus();
    });

    fireEvent.keyDown(confirm, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });
});

describe("ConnectorCard hostile createdAt (F3)", () => {
  it.each([Number.NaN, "not-a-timestamp"])(
    "does not crash the connector list when createdAt is %p",
    async (createdAt) => {
      render(
        <AtlassianConnectorsPanel
          client={clientListing(hostileConnector(createdAt))}
          pollIntervalMs={100000}
        />,
      );
      expect(await screen.findByTestId("acx-connector")).toBeInTheDocument();
      expect(screen.getByText("Docs")).toBeInTheDocument();
    },
  );
});
