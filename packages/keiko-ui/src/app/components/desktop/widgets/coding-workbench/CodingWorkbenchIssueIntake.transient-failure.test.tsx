/**
 * #3384 review 3941836282: once useCodingWorkbenchIssueIntake maps
 * CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE to the UI-local "read-transient-failure" state,
 * the component must actually render the calm, retry-worded copy (not the provider message, not
 * the generic "unknown" copy) with a retry affordance that re-triggers the preview. This renders
 * the intake component directly with a fixed controller state — no server round trip — and pins
 * that render.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodingWorkbenchIssueIntake } from "./CodingWorkbenchIssueIntake";
import type { IssueIntakeController } from "./useCodingWorkbenchIssueIntake";

function controller(overrides: Partial<IssueIntakeController> = {}): IssueIntakeController {
  return {
    issueRef: "#42",
    state: { kind: "empty" },
    change: vi.fn(),
    preview: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

describe("CodingWorkbenchIssueIntake — read-transient-failure", () => {
  it("renders the calm retry-worded message, not the provider status text, with a retry button", () => {
    const preview = vi.fn();
    render(
      <CodingWorkbenchIssueIntake
        intake={controller({
          state: {
            kind: "failed",
            failure: "read-transient-failure",
            correlationId: "corr-1",
          },
          preview,
        })}
        accepted={null}
        repositoryPath="/repos/keiko-checkout"
        runtimePosture="verified"
        pending={false}
        onAccepted={vi.fn()}
        onOpenGit={undefined}
      />,
    );

    const alert = screen.getByTestId("coding-workbench-issue-alert");
    expect(alert).toHaveAttribute("data-failure", "read-transient-failure");
    expect(alert).toHaveTextContent(
      "GitHub could not be reached just now (a rate limit or a temporary error). This is not about the issue itself — try again in a moment.",
    );
    // Never the raw provider/server message, and never the generic unknown-failure copy.
    expect(alert.textContent).not.toMatch(/rate limit or a temporary error\)\.$/u);
    expect(alert).toHaveTextContent("Support id: corr-1.");
  });

  it("retries the preview from the retry button", async () => {
    const user = userEvent.setup();
    const preview = vi.fn();
    render(
      <CodingWorkbenchIssueIntake
        intake={controller({
          state: { kind: "failed", failure: "read-transient-failure", correlationId: undefined },
          preview,
        })}
        accepted={null}
        repositoryPath="/repos/keiko-checkout"
        runtimePosture="verified"
        pending={false}
        onAccepted={vi.fn()}
        onOpenGit={undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
