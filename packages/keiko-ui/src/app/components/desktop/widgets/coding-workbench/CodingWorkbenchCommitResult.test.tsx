import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts";
import { CodingWorkbenchCommitResult } from "./CodingWorkbenchCommitResult";

function receipt(overrides: Partial<VerifiedCommitResult> = {}): VerifiedCommitResult {
  return {
    schemaVersion: "1",
    status: "succeeded",
    reason: "completed",
    recordedAt: "2026-09-04T10:00:00.000Z",
    proposalId: "proposal-1",
    runId: "run-1",
    envelopeDigest: "a".repeat(64),
    runtimeAuthorityDigest: "b".repeat(64),
    workspaceDigest: "c".repeat(64),
    repositoryDigest: "d".repeat(64),
    baseSha: "1".repeat(40),
    parentSha: "2".repeat(40),
    stagedTreeDigest: "3".repeat(64),
    messageDigest: "4".repeat(64),
    verificationEvidenceId: "verification-3386",
    headSha: "5".repeat(40),
    committedTreeDigest: "3".repeat(64),
    ...overrides,
  };
}

function blocked(): VerifiedCommitResult {
  const value = receipt({
    status: "blocked",
    reason: "policy-block",
    blockReason: "protected-branch",
  });
  Reflect.deleteProperty(value, "headSha");
  Reflect.deleteProperty(value, "committedTreeDigest");
  return value;
}

describe("verified commit outcome in the Code task", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the exact successful receipt with no new approval controls", async () => {
    render(<CodingWorkbenchCommitResult result={receipt()} runId="run-1" />);
    expect(screen.getByRole("region", { name: "Commit result" })).toHaveTextContent(
      "Commit created",
    );
    expect(screen.getByText("5".repeat(40))).toBeInTheDocument();
    expect(screen.getByText("verification-3386")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/iu })).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(
      "[keiko] verified commit result displayed: succeeded tree 333333333333",
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("shows the closed kernel policy reason as a finding, never as an approval", () => {
    render(<CodingWorkbenchCommitResult result={blocked()} runId="run-1" />);
    expect(screen.getByText("Commit blocked")).toBeInTheDocument();
    expect(screen.getByText("Target is a protected branch")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["failed", "execution-failed", "Commit failed"],
    ["recovery-required", "execution-uncertain", "Commit needs recovery"],
    ["verification-failed", "verification-missing", "Commit verification failed"],
    ["drift", "candidate-drift", "Commit proposal changed"],
  ] as const)("shows the closed %s outcome without offering approval", (status, reason, label) => {
    const base = blocked();
    Reflect.deleteProperty(base, "blockReason");
    render(<CodingWorkbenchCommitResult result={{ ...base, status, reason }} runId="run-1" />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("removes an old receipt on a run switch and does not repeat its diagnostic on a reread", () => {
    const { rerender } = render(<CodingWorkbenchCommitResult result={receipt()} runId="run-1" />);
    rerender(<CodingWorkbenchCommitResult result={receipt()} runId="run-1" />);
    expect(console.warn).toHaveBeenCalledOnce();
    rerender(<CodingWorkbenchCommitResult result={receipt()} runId="run-2" />);
    expect(screen.queryByRole("region", { name: "Commit result" })).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("shows preflight severity and remediation without raw kernel prose", () => {
    const value = blocked();
    Reflect.deleteProperty(value, "blockReason");
    const result = {
      ...value,
      reason: "preflight-block" as const,
      preflightFindings: [
        {
          code: "nothing-staged-to-commit" as const,
          phase: "preflight" as const,
          severity: "blocking" as const,
          remediation: "user-actionable" as const,
        },
      ],
    };
    render(<CodingWorkbenchCommitResult result={result} runId="run-1" />);
    expect(screen.getByText("No changes are staged for this commit")).toBeInTheDocument();
    expect(screen.getByText(/Blocking.*You can fix this/u)).toBeInTheDocument();
  });

  it("shows the closed message-policy violation codes instead of the rejected message (#3390)", () => {
    const value = blocked();
    Reflect.deleteProperty(value, "blockReason");
    const result = {
      ...value,
      reason: "message-policy" as const,
      violations: ["missing-conventional-prefix" as const, "subject-too-long" as const],
    };
    render(<CodingWorkbenchCommitResult result={result} runId="run-1" />);
    expect(
      screen.getByText(
        'The subject is missing a conventional-commit prefix (for example "feat: ")',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("The subject line exceeds the maximum length")).toBeInTheDocument();
  });

  it.each(["foreign-run", "unknown-field", "unknown-finding", "pending"])(
    "refuses %s without rendering or logging its content",
    (shape) => {
      const result = blocked();
      if (shape === "foreign-run") Reflect.set(result, "runId", "run-2");
      if (shape === "unknown-field") Reflect.set(result, "message", "private message");
      if (shape === "unknown-finding") Reflect.set(result, "blockReason", "private message");
      if (shape === "pending") {
        Reflect.deleteProperty(result, "blockReason");
        Reflect.set(result, "status", "approval-required");
        Reflect.set(result, "reason", "approval-required");
      }
      const { container } = render(<CodingWorkbenchCommitResult result={result} runId="run-1" />);
      expect(container).toBeEmptyDOMElement();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});
