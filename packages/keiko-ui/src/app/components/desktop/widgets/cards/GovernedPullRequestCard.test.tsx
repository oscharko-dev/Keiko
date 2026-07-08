// Behavioural tests for the governed GitHub pull request command center (Issue #477, Epic #470).
// Exercises the metadata editor + readiness/recommendation panel + open/update dispatch with a fully
// mocked api client: empty state, synthesized-draft seeding, mutation payloads, the readable outcome
// banner (created PR / blocked / normalized rejection), and readable API errors.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GovernedPullRequestCard, type GovernedPullRequestClient } from "./GovernedPullRequestCard";
import {
  ApiError,
  type GitDeliveryPrExecuteResponse,
  type GitDeliveryPrPreviewResponse,
} from "@/lib/api";

function makePreview(
  overrides: Partial<GitDeliveryPrPreviewResponse> = {},
): GitDeliveryPrPreviewResponse {
  return {
    schemaVersion: "1",
    actionKind: "pr-create",
    headBranchName: "claude/issue-477-x",
    baseBranchName: "dev",
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    isDraft: false,
    policyOutcome: "allowed",
    composedTitle: "feat(keiko-server): github pr command center",
    composedBody: "## Summary\nfeat: github pr command center",
    riskNarrative: "This change is classified protected-or-merge (severity 3).",
    recommendation: "create-as-ready",
    readiness: { objectExists: false, reviewReady: false, blockerCodes: [] },
    suggestedLabels: ["enhancement"],
    suggestedIssueRefs: ["#477"],
    titleByteLength: 10,
    bodyByteLength: 20,
    ...overrides,
  };
}

function makeExecute(
  overrides: Partial<GitDeliveryPrExecuteResponse> = {},
): GitDeliveryPrExecuteResponse {
  return {
    schemaVersion: "1",
    status: "succeeded",
    actionKind: "pr-create",
    ...overrides,
  };
}

function makeClient(overrides: Partial<GovernedPullRequestClient> = {}): GovernedPullRequestClient {
  return {
    prPreview: vi.fn(async () => makePreview()),
    prExecute: vi.fn(async () => makeExecute({ createdPrExternalId: "1499" })),
    ...overrides,
  };
}

const PROJECT = "/home/me/repo";

function fillForm(): void {
  fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), {
    target: { value: "oscharko-dev/Keiko" },
  });
  fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "dev" } });
  fireEvent.change(screen.getByLabelText("Pull Request title"), {
    target: { value: "feat: x" },
  });
}

describe("GovernedPullRequestCard", () => {
  it("renders an empty state when no project root is provided", () => {
    render(<GovernedPullRequestCard client={makeClient()} />);
    expect(screen.getByTestId("gpr-empty")).toBeInTheDocument();
  });

  it("previews and renders the readiness panel distinguishing object-exists from review-ready", async () => {
    render(
      <GovernedPullRequestCard
        projectId={PROJECT}
        headBranchName="claude/issue-477-x"
        client={makeClient()}
      />,
    );
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gpr-readiness")).toBeInTheDocument());
    const panel = screen.getByTestId("gpr-readiness");
    expect(panel).toHaveTextContent("Remote PR object: not created yet");
    expect(panel).toHaveTextContent("Ready for review: no");
    expect(panel).toHaveTextContent("Recommendation: create-as-ready");
    expect(panel).toHaveTextContent("Linked issues: #477");
  });

  it("seeds the editable title/body from the synthesized draft when empty", async () => {
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />);
    fillForm();
    // Clear the title so the draft seeds it.
    fireEvent.change(screen.getByLabelText("Pull Request title"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), {
      target: { value: "oscharko-dev/Keiko" },
    });
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Pull Request title")).toHaveValue(
        "feat(keiko-server): github pr command center",
      ),
    );
  });

  it("dispatches a governed create with the right payload and surfaces the provider PR number", async () => {
    const prExecute = vi.fn(async () => makeExecute({ createdPrExternalId: "1499" }));
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(prExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        kind: "pr-create",
        ownerAndRepo: "oscharko-dev/Keiko",
        baseBranchName: "dev",
      }),
    );
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("pr: #1499");
  });

  it("dispatches a governed update with the selected PR number and draft transition", async () => {
    const prExecute = vi.fn(async () => makeExecute({ actionKind: "pr-update" }));
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.click(screen.getByLabelText("Update"));
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.change(screen.getByLabelText("Pull Request number"), { target: { value: "1499" } });
    fireEvent.change(screen.getByLabelText("Draft state"), { target: { value: "to-ready" } });

    fireEvent.click(screen.getByTestId("gpr-submit"));

    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(prExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        kind: "pr-update",
        prExternalId: "1499",
        convertFromDraft: true,
        convertToDraft: false,
      }),
    );
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("pr-update: succeeded");
  });

  it("surfaces a policy-blocked outcome with its reason", async () => {
    const prExecute = vi.fn(async () =>
      makeExecute({
        status: "blocked",
        blockReason: "policy-pack-blocked",
      }),
    );
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("pr-create: blocked");
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("reason: policy-pack-blocked");
  });

  it("normalizes a provider rejection into a typed reason + recovery disposition", async () => {
    const prExecute = vi.fn(async () =>
      makeExecute({
        status: "failed",
        executionErrorCode: "provider-rejected",
        prRejectionReason: "validation-error",
        recoveryDisposition: "user-fixable",
      }),
    );
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("rejected: validation-error");
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("recover: user-fixable");
  });

  it("surfaces provider-auth failures without raw provider details", async () => {
    const prExecute = vi.fn(async () =>
      makeExecute({
        status: "failed",
        executionErrorCode: "provider-rejected",
        prRejectionReason: "provider-auth",
        recoveryDisposition: "user-fixable",
        recoveryActionHint: "Reconnect provider access.",
      }),
    );
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("rejected: provider-auth");
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("hint: Reconnect provider access.");
    expect(screen.getByTestId("gpr-outcome")).not.toHaveTextContent(/token|secret|authorization/i);
  });

  it("renders API failures as a readable alert", async () => {
    const prExecute = vi.fn(() =>
      Promise.reject(
        new ApiError("GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE", "worktree unavailable", 409),
      ),
    );
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient({ prExecute })} />);
    fillForm();
    fireEvent.change(screen.getByLabelText("Head branch"), {
      target: { value: "claude/issue-477-x" },
    });
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "worktree unavailable (GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE)",
      ),
    );
  });

  it("hides a finished outcome when the action kind or target changes", async () => {
    render(
      <GovernedPullRequestCard
        projectId={PROJECT}
        headBranchName="claude/issue-477-x"
        client={makeClient()}
      />,
    );
    fillForm();
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    // Switching Create → Update retargets the form: the old "created" banner must disappear —
    // it describes a different action than the one the form now names.
    fireEvent.click(screen.getByRole("radio", { name: "Update" }));
    expect(screen.queryByTestId("gpr-outcome")).not.toBeInTheDocument();
    expect(screen.getByTestId("gpr-live")).toHaveTextContent("");
    // Returning to the executed target restores the still-valid outcome.
    fireEvent.click(screen.getByRole("radio", { name: "Create" }));
    expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument();
  });

  it("hides a stale readiness panel when a target field changes after a preview", async () => {
    render(
      <GovernedPullRequestCard
        projectId={PROJECT}
        headBranchName="claude/issue-477-x"
        client={makeClient()}
      />,
    );
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gpr-readiness")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "main" } });
    expect(screen.queryByTestId("gpr-readiness")).not.toBeInTheDocument();
  });

  it("gates the update flow on a numeric PR number and explains the format", () => {
    const client = makeClient();
    render(
      <GovernedPullRequestCard
        projectId={PROJECT}
        headBranchName="claude/issue-477-x"
        client={client}
      />,
    );
    fillForm();
    fireEvent.click(screen.getByRole("radio", { name: "Update" }));
    fireEvent.change(screen.getByLabelText("Pull Request number"), {
      target: { value: "PR#12" },
    });
    expect(screen.getByTestId("gpr-pr-number-hint")).toHaveTextContent(
      "numeric Pull Request number",
    );
    expect(screen.getByLabelText("Pull Request number")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByTestId("gpr-submit"));
    expect(client.prPreview).not.toHaveBeenCalled();
    expect(client.prExecute).not.toHaveBeenCalled();
  });
});
