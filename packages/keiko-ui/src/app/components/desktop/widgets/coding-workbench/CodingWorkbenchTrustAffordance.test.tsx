import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditorVerificationCatalog,
  WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_VERIFICATION_KINDS,
  EDITOR_VERIFICATION_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/editor-verification";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { WORKSPACE_TRUST_CHANGED_EVENT } from "@/lib/workspace-trust-api";
import {
  CodingWorkbenchTrustAffordance,
  WORKTREE_TRUST_SETTLE_MS,
} from "./CodingWorkbenchTrustAffordance";
import type { CodingWorkbenchRepositoryTrustBinding } from "./useCodingWorkbenchRunWorkspace";

const fetchStatus = vi.hoisted(() => vi.fn());
const mutateTrust = vi.hoisted(() => vi.fn());
const fetchCatalog = vi.hoisted(() => vi.fn());
const diagnostic = vi.hoisted(() => vi.fn());

// Reuses the SAME client the Editor's own verification-trust surface calls
// (`useWorkspaceTrust` → `@/lib/workspace-trust-api`) — mocking at this boundary exercises the real
// hook wiring (fetch-on-mount, grant-then-adopt-response) rather than a second, hand-rolled fetch
// path (AGENTS.md §5). The verification catalog is the runner's own script-trust decision for the
// run's worktree (ADR-0147 D3), read through the same module.
vi.mock("@/lib/workspace-trust-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-trust-api")>()),
  fetchWorkspaceTrustStatus: fetchStatus,
  mutateWorkspaceTrust: mutateTrust,
  fetchVerificationCatalog: fetchCatalog,
}));

vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: diagnostic,
}));

const ALLOW = "Allow package scripts for verification";
const RESTRICTED_NOTICE = /not yet trusted/u;
const DRIFT_NOTICE = /does not cover this task workspace's package scripts/u;
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

// The runner's decision for the worktree: every script-backed kind carries the same state, and
// targeted-test — Keiko-synthesized, exempt from script trust — stays trusted as in production.
function catalog(
  projectId: string,
  scripts: "trusted" | "approval-required",
): EditorVerificationCatalog {
  return {
    schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
    projectId,
    workspaceTrust: status(projectId, scripts === "trusted" ? "trusted" : "restricted"),
    kinds: EDITOR_VERIFICATION_KINDS.map((kind) => ({
      kind,
      available: kind !== "targeted-test",
      trustState: kind === "targeted-test" ? "trusted" : scripts,
    })),
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

// What the real client does after a successful mutation: broadcast the change, which re-reads the
// runner's decision.
function grantSucceeds(nextCatalog: EditorVerificationCatalog): void {
  mutateTrust.mockImplementation((projectId: string): Promise<WorkspaceTrustStatus> => {
    fetchCatalog.mockResolvedValue(nextCatalog);
    window.dispatchEvent(new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId } }));
    return Promise.resolve(status(projectId, "trusted"));
  });
}

beforeEach(() => {
  fetchCatalog.mockResolvedValue(catalog("/worktree-a", "trusted"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CodingWorkbenchTrustAffordance", () => {
  it("renders nothing while no workspace is bound", async () => {
    const { container } = render(<CodingWorkbenchTrustAffordance binding={null} />);

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the bound workspace resolves as trusted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("/repo-a"));
    await waitFor(() =>
      expect(fetchCatalog).toHaveBeenCalledWith("/worktree-a", expect.anything()),
    );
    expect(screen.queryByTestId("coding-workbench-trust-affordance")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the allow action once the bound workspace resolves as restricted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", { name: ALLOW });
    expect(action).toBeEnabled();
    expect(screen.getByText(RESTRICTED_NOTICE)).toBeInTheDocument();
  });

  it("removes a retained restricted action as soon as the validated binding disappears", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const view = render(<CodingWorkbenchTrustAffordance binding={binding()} />);
    await screen.findByRole("button", { name: ALLOW });

    view.rerender(<CodingWorkbenchTrustAffordance binding={null} />);

    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();
  });

  it("grants trust for the repository root through the existing grant route on click", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    mutateTrust.mockResolvedValue(status("/repo-a", "trusted"));
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", { name: ALLOW });
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

    const action = await screen.findByRole("button", { name: ALLOW });
    await user.click(action);

    expect(await screen.findByRole("button", { name: "Allowing…" })).toBeDisabled();
    resolveMutate(status("/repo-a", "trusted"));
  });

  // ADR-0147 D3 (Coding Workbench run 8, 2026-09-10): the repository stays TRUSTED while the run's
  // rewritten worktree manifest is refused, so the repository status can never surface this case.
  // The runner's own decision for the worktree does, and the exit it offers is a grant recorded for
  // the WORKTREE root — the repository's grant cannot clear drift. The repository status is the only
  // status read: the worktree's record is never re-derived in the browser.
  it("offers the worktree grant when the repository is trusted but the run's worktree manifest drifted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    grantSucceeds(catalog("/worktree-a", "trusted"));
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} runRevision={3} />);

    const action = await screen.findByRole("button", { name: ALLOW });
    expect(screen.getByText(DRIFT_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED_NOTICE)).not.toBeInTheDocument();
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/worktree-a", "grant");
    expect(fetchStatus).not.toHaveBeenCalledWith("/worktree-a");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument(),
    );
  });

  // Run 9 setup (2026-09-10): with the repository not opened as a project, its status does not
  // resolve at all and the worktree's scripts are approval-required for that reason. The affordance
  // offered the worktree grant with the drift wording before any run had started -- a wrong cause,
  // and a decision about a worktree under a repository nobody had approved.
  it.each([
    ["an unresolved repository status", undefined],
    ["a rejected repository status read", "reject" as const],
  ])("offers nothing for %s, even when the worktree needs approval", async (_label, mode) => {
    if (mode === "reject") fetchStatus.mockRejectedValue(new Error("trust status unavailable"));
    else fetchStatus.mockResolvedValue(undefined);
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    await waitFor(() => expect(fetchCatalog).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();
    expect(mutateTrust).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the repository grant first while the repository itself is restricted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    mutateTrust.mockResolvedValue(status("/repo-a", "trusted"));
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    const action = await screen.findByRole("button", { name: ALLOW });
    expect(screen.getByText(RESTRICTED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(DRIFT_NOTICE)).not.toBeInTheDocument();
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/repo-a", "grant");
  });

  // #3390 wave (2026-09-10, Coding Workbench run 8): the server already refused the run's
  // verification for want of the workspace-script-trust grant, and `pendingTrustDecision` reads
  // this pause reason before it ever reads the catalog (CodingWorkbenchTrustAffordance.tsx). This
  // is the load-bearing pin: a stale "trusted" catalog read, or an outright failed one, must never
  // hide the one notice that explains why the run is not moving — both are asserted here.
  it.each([
    ["a rejected catalog read", "reject" as const],
    ["a catalog that already reports the worktree scripts as trusted", "trusted" as const],
  ])(
    "shows the run-waiting notice while paused on workspace-script-trust, even with %s",
    async (_label, mode) => {
      fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
      if (mode === "reject") {
        fetchCatalog.mockRejectedValue(new Error("catalog unavailable"));
      } else {
        fetchCatalog.mockResolvedValue(catalog("/worktree-a", "trusted"));
      }

      render(
        <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
      );

      expect(await screen.findByText(RUN_WAITING_NOTICE)).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: ALLOW })).toBeEnabled();
    },
  );

  // A run paused for its worktree's decision while the binding carries no worktree root has
  // nothing the action could grant: the notice still explains the pause, the action is disabled,
  // and a click grants nothing (CodeRabbit review, 2026-09-10).
  it("keeps the run-waiting notice but disables the action when the binding has no worktree root", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "trusted"));
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
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "trusted"));
    mutateTrust.mockResolvedValue(status("/worktree-a", "trusted"));
    const user = userEvent.setup();
    render(
      <CodingWorkbenchTrustAffordance binding={binding()} pauseReason="workspace-script-trust" />,
    );

    const action = await screen.findByRole("button", { name: ALLOW });
    await user.click(action);

    expect(mutateTrust).toHaveBeenCalledExactlyOnceWith("/worktree-a", "grant");
  });

  // A verification refused mid-run is when the exit has to appear: the run's revision moving
  // re-reads the runner's decision once the activity settles.
  it("re-reads the worktree decision once the run's activity settles", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const view = render(<CodingWorkbenchTrustAffordance binding={binding()} runRevision={1} />);
    await waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();

    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    view.rerender(<CodingWorkbenchTrustAffordance binding={binding()} runRevision={2} />);

    await screen.findByRole(
      "button",
      { name: ALLOW },
      { timeout: WORKTREE_TRUST_SETTLE_MS + 2000 },
    );
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it("reports a refused worktree grant under the server's correlation id and keeps the action", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    mutateTrust.mockRejectedValue(
      Object.assign(new Error("denied"), {
        code: "PROJECT_NOT_FOUND",
        correlationId: "trust-grant-refusal-1",
      }),
    );
    const user = userEvent.setup();
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);

    await user.click(await screen.findByRole("button", { name: ALLOW }));

    await waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith(
        "[keiko] coding workbench worktree trust grant refused",
        { correlationId: "trust-grant-refusal-1" },
      ),
    );
    expect(await screen.findByRole("button", { name: ALLOW })).toBeEnabled();
  });

  // CodeRabbit (PR #3452): a non-abort catalog-read failure in useWorktreeScriptTrust cleared the
  // decision with no diagnostic at all. The note is a fixed, body-free string like the others in
  // this folder -- never the worktree root or the error's own text.
  it("reports a body-free diagnostic when the worktree script-trust catalog read fails for a reason other than abort", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockRejectedValue(new Error("catalog store unavailable at /private/worktree-a"));
    render(<CodingWorkbenchTrustAffordance binding={binding()} />);
    diagnostic.mockClear();

    await waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(1));
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] coding workbench worktree script trust catalog read failed",
    );
  });

  it("reports nothing when the worktree script-trust catalog read is aborted", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockImplementationOnce(
      (_root: string, signal: AbortSignal): Promise<EditorVerificationCatalog> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    fetchCatalog.mockResolvedValue(catalog("/worktree-b", "trusted"));
    const view = render(
      <CodingWorkbenchTrustAffordance binding={binding("/repo-a", "/worktree-a")} />,
    );
    await waitFor(() =>
      expect(fetchCatalog).toHaveBeenCalledWith("/worktree-a", expect.anything()),
    );
    diagnostic.mockClear();

    view.rerender(<CodingWorkbenchTrustAffordance binding={binding("/repo-a", "/worktree-b")} />);
    await waitFor(() =>
      expect(fetchCatalog).toHaveBeenCalledWith("/worktree-b", expect.anything()),
    );

    expect(diagnostic).not.toHaveBeenCalledWith(
      "[keiko] coding workbench worktree script trust catalog read failed",
    );
  });

  it("reads no worktree decision while the binding names no worktree", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const { container } = render(
      <CodingWorkbenchTrustAffordance binding={binding("/repo-a", null)} />,
    );

    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("/repo-a"));
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  // CWE-863 (CodeRabbit review, PR #3452): a worktree-root change must drop root A's decision at
  // once, not keep rendering it while root B's own catalog read is still in flight -- otherwise a
  // click would grant B's root on the strength of A's stale "approval-required" decision, because
  // `useWorktreeTrustGrant(worktreeRoot, ...)` always rebinds to the CURRENT root while the old
  // `useWorktreeScriptTrust` state could still be answering for the OLD one.
  it("stops offering A's drift-notice allow action once the worktree root changes to B, before B's catalog answers", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    fetchCatalog.mockResolvedValue(catalog("/worktree-a", "approval-required"));
    const view = render(
      <CodingWorkbenchTrustAffordance binding={binding("/repo-a", "/worktree-a")} />,
    );

    await screen.findByRole("button", { name: ALLOW });
    expect(screen.getByText(DRIFT_NOTICE)).toBeInTheDocument();

    // Root B's own catalog read is still unresolved at the point of the assertions below.
    let resolveCatalogB: (value: EditorVerificationCatalog) => void = () => undefined;
    fetchCatalog.mockReturnValue(
      new Promise<EditorVerificationCatalog>((resolve) => {
        resolveCatalogB = resolve;
      }),
    );
    view.rerender(<CodingWorkbenchTrustAffordance binding={binding("/repo-a", "/worktree-b")} />);
    await waitFor(() =>
      expect(fetchCatalog).toHaveBeenCalledWith("/worktree-b", expect.anything()),
    );

    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument();
    expect(screen.queryByText(DRIFT_NOTICE)).not.toBeInTheDocument();

    resolveCatalogB(catalog("/worktree-b", "trusted"));
  });

  it("has no serious or critical axe violations while the action is shown", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "restricted"));
    const { container } = render(<CodingWorkbenchTrustAffordance binding={binding()} />);
    await screen.findByRole("button", { name: ALLOW });

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
