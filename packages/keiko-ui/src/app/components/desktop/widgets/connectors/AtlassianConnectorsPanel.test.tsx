// Issue #2245 — the top-level connector management surface: lists connectors, adds one (write-only
// token flow), verifies, manages (scope + sync), and deletes with confirmation. Whole-panel axe
// runs in light AND dark.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AtlassianConnectorsPanel } from "./AtlassianConnectorsPanel";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";

const DOCS: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
};

const NEWONE: AtlassianConnectorMetadata = {
  ...DOCS,
  authRef: "atlassian-cred:BBBBBBBBBBBBBBBBBBBBBB",
  displayName: "Ops",
};

function makeClient(overrides: Partial<AtlassianConnectorsClient> = {}): AtlassianConnectorsClient {
  return {
    listConnectors: vi.fn(async () => [DOCS]),
    createConnector: vi.fn(async () => NEWONE),
    deleteConnector: vi.fn(async () => ({ ok: true as const })),
    verifyConnector: vi.fn(async () => ({ authRef: DOCS.authRef, status: "ok" as const })),
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
    ...overrides,
  };
}

describe("AtlassianConnectorsPanel", () => {
  it("lists configured connectors with provider, label, and base URL", async () => {
    render(<AtlassianConnectorsPanel client={makeClient()} pollIntervalMs={100000} />);
    const card = await screen.findByTestId("acx-connector");
    expect(card).toHaveTextContent("Docs");
    expect(card).toHaveTextContent("Confluence");
    expect(card).toHaveTextContent("https://x.atlassian.net");
  });

  it("adds a connector and shows it in the list", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Add connector" }));
    await user.type(screen.getByLabelText("Label"), "Ops");
    await user.type(screen.getByLabelText("Base URL"), "https://x.atlassian.net");
    await user.type(screen.getByLabelText("Account email"), "me@example.com");
    await user.type(screen.getByLabelText("API token"), "tok");
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    await waitFor(() => expect(screen.getByText("Ops")).toBeInTheDocument());
  });

  it("verifies a connector inline and reveals the sync surface on manage", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Verify connection" }));
    await waitFor(() => expect(vi.mocked(client.verifyConnector)).toHaveBeenCalled());
    expect(await screen.findByTestId("acx-verify-status")).toHaveAttribute("data-status", "ok");
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByTestId("acx-sync")).toBeInTheDocument();
  });

  it("deletes a connector after confirmation", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete connector" }));
    await waitFor(() =>
      expect(vi.mocked(client.deleteConnector)).toHaveBeenCalledWith(DOCS.authRef),
    );
    await waitFor(() => expect(screen.queryByText("Docs")).toBeNull());
  });

  it("has no axe violations across the loaded panel (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(
        <AtlassianConnectorsPanel client={makeClient()} pollIntervalMs={100000} />,
      );
      await screen.findByTestId("acx-connector");
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
