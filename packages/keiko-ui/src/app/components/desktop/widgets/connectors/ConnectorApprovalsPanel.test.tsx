// Issue #2245 (AC — approvals) — pending write actions render with their disposition context; an
// approve executes and shows the typed result (success / closed failure reason / content-free denied
// reason); a reject records the rejection; the surface is keyboard-operable end to end.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { AtlassianConnectorPendingApproval } from "@oscharko-dev/keiko-contracts";
import { ConnectorApprovalsPanel, type ApprovalsClient } from "./ConnectorApprovalsPanel";

const APPROVAL: AtlassianConnectorPendingApproval = {
  schemaVersion: "1",
  approvalId: "ap1",
  connectorId: "c1",
  provider: "jira",
  actionType: "create-issue",
  actionClass: "connector-write",
  requiredScope: "issue-tracker.write",
  risk: "high",
  reviewReason: "deterministic-risk-approval-required",
  targetRef: "PROJ-1",
  correlationId: "corr1",
  requestedAt: 0,
  expiresAt: 1000,
};

function makeClient(overrides: Partial<ApprovalsClient> = {}): ApprovalsClient {
  return {
    listApprovals: vi.fn(async () => [APPROVAL]),
    approveAction: vi.fn(async () => ({
      disposition: "review-required" as const,
      result: { status: "succeeded" as const, targetRef: "PROJ-1" },
    })),
    rejectAction: vi.fn(async () => ({
      approvalId: "ap1",
      disposition: "review-required" as const,
      outcome: "cancelled" as const,
    })),
    ...overrides,
  };
}

describe("ConnectorApprovalsPanel — rendering", () => {
  it("renders a pending action with its disposition context", async () => {
    render(<ConnectorApprovalsPanel client={makeClient()} />);
    const row = await screen.findByTestId("acx-approval");
    expect(row).toHaveTextContent("Create Jira issue");
    expect(row).toHaveTextContent("PROJ-1");
    expect(row).toHaveTextContent("High");
    expect(row).toHaveTextContent("Review required");
    expect(row).toHaveTextContent(/high-risk action always requires approval/i);
  });

  it("shows the empty state when nothing is pending", async () => {
    render(
      <ConnectorApprovalsPanel client={makeClient({ listApprovals: vi.fn(async () => []) })} />,
    );
    expect(await screen.findByText(/No write actions are waiting/i)).toBeInTheDocument();
  });
});

describe("ConnectorApprovalsPanel — approve outcomes", () => {
  it("approves and shows a typed success result", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<ConnectorApprovalsPanel client={client} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const result = await screen.findByTestId("acx-approval-result");
    expect(result).toHaveAttribute("data-tone", "ok");
    expect(result).toHaveTextContent(/Result: PROJ-1/);
    expect(vi.mocked(client.approveAction)).toHaveBeenCalledWith("ap1");
  });

  it("shows a closed write-failure reason on a failed execution", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      approveAction: vi.fn(async () => ({
        disposition: "review-required" as const,
        result: { status: "failed" as const, reason: "conflict" as const },
      })),
    });
    render(<ConnectorApprovalsPanel client={client} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const result = await screen.findByTestId("acx-approval-result");
    expect(result).toHaveAttribute("data-tone", "danger");
    expect(result).toHaveTextContent(/changed since it was read/i);
  });

  it("renders the content-free denied reason when the envelope re-check denies", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      approveAction: vi.fn(async () => ({
        disposition: "denied" as const,
        reasonCode: "authority-expired" as const,
      })),
    });
    render(<ConnectorApprovalsPanel client={client} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const denied = await screen.findByTestId("acx-approval-denied");
    expect(denied).toHaveTextContent(/authority for this action has expired/i);
  });
});

describe("ConnectorApprovalsPanel — reject and keyboard", () => {
  it("rejects and records the rejection without executing", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<ConnectorApprovalsPanel client={client} />);
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByTestId("acx-approval-rejected")).toHaveTextContent(
      /was not executed/i,
    );
    expect(vi.mocked(client.rejectAction)).toHaveBeenCalledWith("ap1");
    expect(vi.mocked(client.approveAction)).not.toHaveBeenCalled();
  });

  it("approves via keyboard only", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<ConnectorApprovalsPanel client={client} />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await user.tab();
    expect(approve).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(vi.mocked(client.approveAction)).toHaveBeenCalledWith("ap1"));
  });

  it("has no axe violations (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(<ConnectorApprovalsPanel client={makeClient()} />);
      await screen.findByTestId("acx-approval");
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
