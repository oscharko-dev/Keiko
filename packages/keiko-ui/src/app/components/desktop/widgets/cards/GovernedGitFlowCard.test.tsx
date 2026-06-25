// Behavioural tests for the governed local Git flow surface (Issue #475, Epic #470). Exercises the
// branch / staging / commit walk with a fully mocked api client: empty state, mutation dispatch with
// the right payloads, live preview rendering (warnings / violations / findings / suggested prefix /
// policy), and the readable outcome banner for succeeded / blocked / approval-required outcomes.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GovernedGitFlowCard, type GovernedGitFlowClient } from "./GovernedGitFlowCard";
import type {
  GitDeliveryCommitPreviewResponse,
  GitDeliveryMutationResponse,
  GitDeliveryPushPreviewResponse,
} from "@/lib/api";

function makeClient(overrides: Partial<GovernedGitFlowClient> = {}): GovernedGitFlowClient {
  const ok: GitDeliveryMutationResponse = {
    schemaVersion: "1",
    status: "succeeded",
    actionKind: "branch-create",
  };
  return {
    branchCreate: vi.fn(async () => ok),
    branchSwitch: vi.fn(async () => ({ ...ok, actionKind: "branch-switch" })),
    stage: vi.fn(async () => ({ ...ok, actionKind: "stage" })),
    unstage: vi.fn(async () => ({ ...ok, actionKind: "unstage" })),
    commitPreview: vi.fn(async () => makePreview()),
    commitExecute: vi.fn(async () => ({ ...ok, actionKind: "commit" })),
    pushPreview: vi.fn(async () => makePushPreview()),
    pushExecute: vi.fn(async () => ({ ...ok, actionKind: "push" })),
    ...overrides,
  };
}

function makePushPreview(
  overrides: Partial<GitDeliveryPushPreviewResponse> = {},
): GitDeliveryPushPreviewResponse {
  return {
    schemaVersion: "1",
    remoteAlias: "origin",
    remoteBranchName: "feat/x",
    sourceBranchName: "feat/x",
    riskClass: "publish",
    wouldCreateRemoteBranch: true,
    wouldTriggerChecks: true,
    forceBlocked: false,
    preflightBlockingCodes: [],
    preflightAdvisoryCodes: [],
    policyOutcome: "constrained",
    ...overrides,
  };
}

function makePreview(
  overrides: Partial<GitDeliveryCommitPreviewResponse> = {},
): GitDeliveryCommitPreviewResponse {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 3, areaCount: 2, areas: ["src", "docs"], touchesTests: true },
    intent: {
      warnings: ["mixed-scope", "wip-marker"],
      mixedScope: true,
      isWip: true,
      suggestedSubjectPrefix: "feat(src): ",
    },
    messageValidation: { ok: false, violations: ["missing-conventional-prefix"] },
    preflightFindingCodes: ["uncommitted-changes"],
    policyOutcome: "allowed",
    ...overrides,
  };
}

const PROJECT = "/home/me/repo";

describe("GovernedGitFlowCard", () => {
  it("renders an empty state when no project root is provided", () => {
    render(<GovernedGitFlowCard client={makeClient()} />);
    expect(screen.getByTestId("ggit-empty")).toBeInTheDocument();
    expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
  });

  it("renders the three flow sections for a project", () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    expect(screen.getByLabelText("Branch")).toBeInTheDocument();
    expect(screen.getByLabelText("Staging")).toBeInTheDocument();
    expect(screen.getByLabelText("Commit")).toBeInTheDocument();
  });

  it("dispatches branch-create with the typed payload and shows the outcome", async () => {
    const client = makeClient();
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feat/x" } });
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Start-point ref hash"), {
      target: { value: "abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(client.branchCreate).toHaveBeenCalledWith({
      projectId: PROJECT,
      branchName: "feat/x",
      baseBranchName: "main",
      startPointRefHash: "abc123",
    });
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("branch-create: Succeeded");
  });

  it("dispatches branch-switch with the typed payload", async () => {
    const client = makeClient();
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Switch to branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await waitFor(() => expect(client.branchSwitch).toHaveBeenCalled());
    expect(client.branchSwitch).toHaveBeenCalledWith({ projectId: PROJECT, branchName: "main" });
  });

  it("dispatches stage with parsed pathspecs and includeUntracked", async () => {
    const client = makeClient();
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Pathspecs"), {
      target: { value: "src/a.ts\n src/b.ts \n" },
    });
    fireEvent.click(screen.getByLabelText("Include untracked files"));
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(client.stage).toHaveBeenCalled());
    expect(client.stage).toHaveBeenCalledWith({
      projectId: PROJECT,
      pathspecs: ["src/a.ts", "src/b.ts"],
      includeUntracked: true,
    });
  });

  it("dispatches unstage with parsed pathspecs", async () => {
    const client = makeClient();
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Pathspecs"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Unstage" }));
    await waitFor(() => expect(client.unstage).toHaveBeenCalled());
    expect(client.unstage).toHaveBeenCalledWith({
      projectId: PROJECT,
      pathspecs: ["src/a.ts"],
    });
  });

  it("renders the live preview: counts, suggested prefix, warnings, violations, findings, policy", async () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "wip changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("ggit-preview")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-preview")).toHaveTextContent("3 staged files across 2 areas");
    expect(screen.getByTestId("ggit-suggested-prefix")).toHaveTextContent("feat(src):");
    expect(screen.getByTestId("ggit-warnings")).toHaveTextContent("Mixed scope");
    expect(screen.getByTestId("ggit-violations")).toHaveTextContent(
      "Missing a conventional-commit type prefix",
    );
    expect(screen.getByTestId("ggit-findings")).toHaveTextContent("uncommitted-changes");
    expect(screen.getByTestId("ggit-policy")).toHaveTextContent("Policy: allowed");
  });

  it("surfaces a message-policy block from commit/execute as readable text", async () => {
    const client = makeClient({
      commitExecute: vi.fn(async () => ({
        schemaVersion: "1" as const,
        status: "blocked" as const,
        actionKind: "commit",
        blockReason: "message-policy",
        messageViolations: ["missing-conventional-prefix" as const],
      })),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    const outcome = screen.getByTestId("ggit-outcome");
    expect(outcome).toHaveTextContent("commit: Blocked");
    expect(outcome).toHaveTextContent("reason: message-policy");
    expect(outcome).toHaveTextContent("Missing a conventional-commit type prefix");
  });

  it("surfaces an approval-required outcome with the required approvers", async () => {
    const client = makeClient({
      commitExecute: vi.fn(async () => ({
        schemaVersion: "1" as const,
        status: "approval-required" as const,
        actionKind: "commit",
        requiredApprovers: ["release-captain"],
      })),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "feat: ok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("commit: Approval required");
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("approver: release-captain");
  });

  it("renders a preflight-block outcome with the finding codes", async () => {
    const client = makeClient({
      stage: vi.fn(async () => ({
        schemaVersion: "1" as const,
        status: "blocked" as const,
        actionKind: "stage",
        preflightFindingCodes: ["nothing-to-stage"],
      })),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Pathspecs"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("preflight: nothing-to-stage");
  });

  it("shows a readable error when a mutation rejects", async () => {
    const client = makeClient({
      branchSwitch: vi.fn(async () => {
        throw new Error("worktree unavailable");
      }),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Switch to branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("worktree unavailable"),
    );
  });

  it("renders an ok preview without violations or warnings cleanly", async () => {
    const client = makeClient({
      commitPreview: vi.fn(async () =>
        makePreview({
          intent: { warnings: [], mixedScope: false, isWip: false },
          messageValidation: { ok: true },
          preflightFindingCodes: [],
        }),
      ),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "feat: ok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("ggit-preview")).toBeInTheDocument());
    expect(screen.queryByTestId("ggit-warnings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ggit-violations")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ggit-findings")).not.toBeInTheDocument();
  });

  it("renders the publish section and shows the push preview risk summary", async () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    expect(screen.getByLabelText("Publish")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "feat/x" } });
    fireEvent.change(screen.getByLabelText("Remote branch"), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
    await waitFor(() => expect(screen.getByTestId("ggit-push-preview")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-push-preview")).toHaveTextContent("origin");
    expect(screen.getByTestId("ggit-push-policy")).toHaveTextContent("Policy: constrained");
  });

  it("dispatches a governed push with the typed payload", async () => {
    const client = makeClient();
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "feat/x" } });
    fireEvent.change(screen.getByLabelText("Remote branch"), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByLabelText("Set upstream tracking"));
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(client.pushExecute).toHaveBeenCalled());
    expect(client.pushExecute).toHaveBeenCalledWith({
      projectId: PROJECT,
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      sourceBranchName: "feat/x",
      setUpstreamTracking: true,
    });
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("push: Succeeded");
  });

  it("surfaces a protected-target policy block from push/execute as readable text", async () => {
    const client = makeClient({
      pushExecute: vi.fn(async () => ({
        schemaVersion: "1" as const,
        status: "blocked" as const,
        actionKind: "push",
        blockReason: "policy-pack-blocked",
      })),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "feat/x" } });
    fireEvent.change(screen.getByLabelText("Remote branch"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("push: Blocked");
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("reason: policy-pack-blocked");
  });

  it("surfaces a non-fast-forward rejection with its recovery hint as readable text", async () => {
    const client = makeClient({
      pushExecute: vi.fn(async () => ({
        schemaVersion: "1" as const,
        status: "failed" as const,
        actionKind: "push",
        executionErrorCode: "precondition-failed",
        publishRejectionReason: "non-fast-forward",
        recoveryDisposition: "user-fixable",
        recoveryActionHint: "resolve-conflicts",
      })),
    });
    render(<GovernedGitFlowCard projectId={PROJECT} client={client} />);
    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "feat/x" } });
    fireEvent.change(screen.getByLabelText("Remote branch"), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    const outcome = screen.getByTestId("ggit-outcome");
    expect(outcome).toHaveTextContent("push: Failed");
    expect(outcome).toHaveTextContent("publish rejected: non-fast-forward");
    expect(outcome).toHaveTextContent("recover: resolve-conflicts");
  });
});
