import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { CodingWorkbenchTrustAffordance } from "./CodingWorkbenchTrustAffordance";
import type { CodingWorkbenchRepositoryTrustBinding } from "./useCodingWorkbenchRunWorkspace";

const fetchStatus = vi.hoisted(() => vi.fn());
const mutateTrust = vi.hoisted(() => vi.fn());
const diagnostic = vi.hoisted(() => vi.fn());

// Reuses the SAME client the Editor's own verification-trust surface calls
// (`useWorkspaceTrust` → `@/lib/workspace-trust-api`) — mocking at this boundary exercises the real
// hook wiring (fetch-on-pause, grant-then-adopt-response) rather than a second, hand-rolled fetch
// path (AGENTS.md §5).
vi.mock("@/lib/workspace-trust-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-trust-api")>()),
  fetchWorkspaceTrustStatus: fetchStatus,
  mutateWorkspaceTrust: mutateTrust,
}));

vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: diagnostic,
}));

const ALLOW = "Allow package scripts for verification";
const RUN_WAITING_NOTICE = /This run is paused/u;

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

function binding(
  repositoryRoot = "/repo-a",
  worktreeRoot: string | null = "/worktree-a",
): CodingWorkbenchRepositoryTrustBinding {
  return {
    repositoryRoot,
    worktreeRoot,
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

  it("renders nothing and reads no trust state until a run is actually waiting", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId("coding-workbench-trust-affordance")).not.toBeInTheDocument();
  });

  it("shows the run-waiting action once the repository resolves as restricted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    const action = await screen.findByRole("button", { name: ALLOW });
    expect(action).toBeEnabled();
    expect(screen.getByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
  });

  it("removes a retained restricted action as soon as the validated binding disappears", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const view = render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );
    await screen.findByRole("button", { name: ALLOW });

    view.rerender(<CodingWorkbenchTrustAffordance binding={null} />);

    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();
  });

  it("grants the repository root while the paused run waits on an untrusted repository", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    // Both grant targets resolve the same "trusted" response — the load-bearing invariant is that
    // the repository grant fires FIRST while the repo is restricted, and only then does the
    // affordance offer the drift-case worktree grant (ADR-0147 D3).
    mutateTrust
      .mockResolvedValueOnce(status("/repo-a", "trusted"))
      .mockResolvedValueOnce(status("/worktree-a", "trusted"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    // #3506 review — `visiblePendingTrustDecision` composes the pause key as
    // `${target.pauseKey}${pending.grantTarget}`, so accepting the repository grant no longer
    // suppresses a still-required worktree grant. Click the repository grant first...
    const repositoryAction = await screen.findByRole("button", { name: ALLOW });
    await user.click(repositoryAction);
    await waitFor(() => expect(mutateTrust).toHaveBeenNthCalledWith(1, "/repo-a", "grant"));

    // ...the affordance stays visible for the drift-case worktree grant. Grant that too, and only
    // then the affordance clears — proving the pause key IS bound to the grant target and each
    // decision is accepted independently rather than the earlier repository acceptance masking it.
    const worktreeAction = await screen.findByRole("button", { name: ALLOW });
    await user.click(worktreeAction);
    await waitFor(() => expect(mutateTrust).toHaveBeenNthCalledWith(2, "/worktree-a", "grant"));
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
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    const action = await screen.findByRole("button", { name: ALLOW });
    await user.click(action);

    expect(await screen.findByRole("button", { name: "Allowing…" })).toBeDisabled();
    resolveMutate(status("/repo-a", "trusted"));
  });

  // ADR-0147 D3 (Coding Workbench run 8, 2026-09-10): when the repository is already trusted, a
  // paused workspace-script-trust decision is the drift case. The repository's grant cannot clear
  // that; the action records an explicit grant for the WORKTREE root.
  it("grants the worktree root while the paused run waits under a trusted repository", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    mutateTrust.mockResolvedValue(status("/worktree-a", "trusted"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    const action = await screen.findByRole("button", { name: ALLOW });
    expect(screen.getByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/worktree-a", "grant");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument(),
    );
  });

  // Run 9 setup (2026-09-10): with the repository not opened as a project, its status does not
  // resolve at all. Before a run is blocked, this is not a header-level issue; while a run is
  // blocked, the notice stays visible but the action is disabled rather than granting blind.
  it.each([
    ["an unresolved repository status", undefined],
    ["a rejected repository status read", "reject" as const],
  ])("offers nothing before a run is waiting for %s", async (_label, mode) => {
    if (mode === "reject") fetchStatus.mockRejectedValue(new Error("trust status unavailable"));
    else fetchStatus.mockResolvedValue(undefined);
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();
    expect(mutateTrust).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the paused notice but disables the action while repository trust cannot be read", async () => {
    fetchStatus.mockRejectedValue(new Error("trust status unavailable"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    expect(await screen.findByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
    const action = await screen.findByRole("button", { name: ALLOW });
    expect(action).toBeDisabled();
    await user.click(action);

    expect(mutateTrust).not.toHaveBeenCalled();
  });

  // #3390 wave (2026-09-10, Coding Workbench run 8): the server already refused the run's
  // verification for want of the workspace-script-trust grant. This is the load-bearing pin: the
  // notice appears from the pause reason itself, not from a proactive catalog read that would make
  // ordinary questions look blocked.
  it("shows the run-waiting notice while paused on workspace-script-trust", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));

    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    expect(await screen.findByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: ALLOW })).toBeEnabled();
  });

  // A run paused for its worktree's decision while the binding carries no worktree root has
  // nothing the action could grant: the notice still explains the pause, the action is disabled,
  // and a click grants nothing (CodeRabbit review, 2026-09-10).
  it("keeps the run-waiting notice but disables the action when the binding has no worktree root", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance
        binding={binding("/repo-a", null)}
        pauseReason="workspace-script-trust"
      />,
    );

    expect(await screen.findByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
    const action = await screen.findByRole("button", { name: ALLOW });
    expect(action).toBeDisabled();
    await user.click(action);
    expect(mutateTrust).not.toHaveBeenCalled();
  });

  it("grants the worktree, not the repository, when the run-waiting action is clicked", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    mutateTrust.mockResolvedValue(status("/worktree-a", "trusted"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    const action = await screen.findByRole("button", { name: ALLOW });
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/worktree-a", "grant");
  });

  it("reports a refused worktree grant under the server's correlation id and keeps the action", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    mutateTrust.mockRejectedValue(
      Object.assign(new Error("denied"), {
        code: "PROJECT_NOT_FOUND",
        correlationId: "trust-grant-refusal-1",
      }),
    );
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    await user.click(await screen.findByRole("button", { name: ALLOW }));

    await waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith(
        "[keiko] coding workbench worktree trust grant refused",
        { correlationId: "trust-grant-refusal-1" },
      ),
    );
    expect(await screen.findByRole("button", { name: ALLOW })).toBeEnabled();
  });

  it("reads no worktree decision while the binding names no worktree", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const { container } = render(
      <CodingWorkbenchTrustAffordance
        binding={binding("/repo-a", null)}
        pauseReason="workspace-script-trust"
      />,
    );

    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("/repo-a"));
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: ALLOW })).toBeDisabled();
  });

  it("switches the grant target when the paused run's worktree root changes", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    mutateTrust.mockResolvedValue(status("/worktree-b", "trusted"));
    const view = render(
      <CodingWorkbenchTrustAffordance
        binding={binding("/repo-a", "/worktree-a")}
        pauseReason="workspace-script-trust"
      />,
    );

    await screen.findByRole("button", { name: ALLOW });
    view.rerender(
      <CodingWorkbenchTrustAffordance
        binding={binding("/repo-a", "/worktree-b")}
        pauseReason="workspace-script-trust"
      />,
    );

    await userEvent.setup().click(await screen.findByRole("button", { name: ALLOW }));

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/worktree-b", "grant");
  });

  it("has no serious or critical axe violations while the action is shown", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const { container } = render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );
    await screen.findByRole("button", { name: ALLOW });

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
