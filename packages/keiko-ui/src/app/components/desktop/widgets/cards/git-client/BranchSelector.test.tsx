import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GitBranchListEntry } from "@/lib/api";

import { BranchSelector } from "./BranchSelector";

const BRANCHES: readonly GitBranchListEntry[] = [
  { name: "codex/fix-model-readiness-startup", headRefHash: "abc123", current: true },
];

describe("BranchSelector", () => {
  it("keeps the branch and new-branch controls on the shared header control height", () => {
    render(
      <BranchSelector
        branches={BRANCHES}
        currentBranch="codex/fix-model-readiness-startup"
        loading={false}
        disabled={false}
        busy={false}
        branchesError={null}
        onSwitchBranch={vi.fn()}
        onCreateBranch={vi.fn()}
        onRetryBranches={vi.fn()}
      />,
    );

    const branchButton = screen.getByRole("button", {
      name: "Branch: codex/fix-model-readiness-startup",
    });
    const newButton = screen.getByRole("button", { name: "New branch" });

    expect(branchButton).toHaveStyle({ height: "var(--control-height)" });
    expect(newButton).toHaveStyle({
      height: "var(--control-height)",
    });
    expect(branchButton.querySelector("svg")).toHaveStyle({ color: "var(--text-accent)" });
    expect(newButton.querySelector("svg")).toHaveStyle({ color: "var(--text-accent)" });
  });

  // #3651: a failed branch-list read must not disable switching/creation as though the
  // repository simply had no branches — it must explain the failure and offer a retry.
  it("shows the branch-list error and a retry action instead of the switch/New controls", async () => {
    const user = userEvent.setup();
    const onRetryBranches = vi.fn();
    render(
      <BranchSelector
        branches={[]}
        currentBranch=""
        loading={false}
        disabled={false}
        busy={false}
        branchesError="Branch list unavailable."
        onSwitchBranch={vi.fn()}
        onCreateBranch={vi.fn()}
        onRetryBranches={onRetryBranches}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Branch list unavailable.");
    expect(screen.queryByRole("button", { name: /^Branch:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New branch" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryBranches).toHaveBeenCalledTimes(1);
  });
});
