import { render, screen } from "@testing-library/react";
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
        onSwitchBranch={vi.fn()}
        onCreateBranch={vi.fn()}
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
});
