import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { CodingWorkbenchTrustAffordance } from "./CodingWorkbenchTrustAffordance";
import type { CodingWorkbenchRepositoryTrustBinding } from "./useCodingWorkbenchRunWorkspace";

const fetchStatus = vi.hoisted(() => vi.fn());
const mutateTrust = vi.hoisted(() => vi.fn());

// Reuses the SAME client the Editor's own verification-trust surface calls
// (`useWorkspaceTrust` → `@/lib/workspace-trust-api`) — mocking at this boundary exercises the real
// hook wiring (fetch-on-mount, grant-then-adopt-response) rather than a second, hand-rolled fetch
// path (AGENTS.md §5).
vi.mock("@/lib/workspace-trust-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-trust-api")>()),
  fetchWorkspaceTrustStatus: fetchStatus,
  mutateWorkspaceTrust: mutateTrust,
}));

function status(projectId: string, trust: "trusted" | "restricted"): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust,
    decidedBy: "server",
    reason: trust === "trusted" ? "human-grant" : "human-revocation",
    revision: 1,
  };
}

function binding(repositoryRoot = "/repo-a"): CodingWorkbenchRepositoryTrustBinding {
  return {
    repositoryRoot,
    repositoryId: "repository-a",
    workspaceId: "workspace-a",
    correlationId: "correlation-workspace-a",
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CodingWorkbenchTrustAffordance", () => {
  it("renders nothing while no workspace is bound", async () => {
    const { container } = render(<CodingWorkbenchTrustAffordance binding={null} />);

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the bound workspace resolves as trusted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("/repo-a"));
    expect(screen.queryByTestId("coding-workbench-trust-affordance")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the allow action once the bound workspace resolves as restricted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", {
      name: "Allow package scripts for verification",
    });
    expect(action).toBeEnabled();
  });

  it("removes a retained restricted action as soon as the validated binding disappears", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const view = render(<CodingWorkbenchTrustAffordance binding={binding()} />);
    await screen.findByRole("button", { name: "Allow package scripts for verification" });

    view.rerender(<CodingWorkbenchTrustAffordance binding={null} />);

    expect(
      screen.queryByRole("button", { name: "Allow package scripts for verification" }),
    ).not.toBeInTheDocument();
  });

  it("grants trust for the workspace root through the existing grant route on click", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    mutateTrust.mockResolvedValue(status("/repo-a", "trusted"));
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", {
      name: "Allow package scripts for verification",
    });
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/repo-a", "grant");
    // The grant response IS the re-read status: the affordance adopts it directly and, once
    // trusted, removes the action rather than leaving a stale "restricted" button behind.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Allow package scripts/u }),
      ).not.toBeInTheDocument(),
    );
  });

  it("disables the action while the grant is in flight", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    let resolveMutate: (value: WorkspaceTrustStatus) => void = () => undefined;
    mutateTrust.mockReturnValue(
      new Promise<WorkspaceTrustStatus>((resolve) => {
        resolveMutate = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", {
      name: "Allow package scripts for verification",
    });
    await user.click(action);

    expect(await screen.findByRole("button", { name: "Allowing…" })).toBeDisabled();
    resolveMutate(status("/repo-a", "trusted"));
  });

  it("has no serious or critical axe violations while the action is shown", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);
    await screen.findByRole("button", { name: "Allow package scripts for verification" });

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
