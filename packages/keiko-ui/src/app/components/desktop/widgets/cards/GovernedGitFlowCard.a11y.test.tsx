// a11y smoke tests for the governed local Git flow surface (Issue #475, AC parity with #473). jest-axe
// scans the empty state, the default flow, the loaded-preview state, and an outcome banner; asserts the
// polite live region exists for async outcome announcements; and asserts severity / outcome are
// conveyed by TEXT, not colour alone.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { GovernedGitFlowCard, type GovernedGitFlowClient } from "./GovernedGitFlowCard";
import type { GitDeliveryCommitPreviewResponse, GitDeliveryMutationResponse } from "@/lib/api";

const PREVIEW: GitDeliveryCommitPreviewResponse = {
  schemaVersion: "1",
  summary: { stagedFileCount: 2, areaCount: 1, areas: ["src"], touchesTests: false },
  intent: {
    warnings: ["large-change"],
    mixedScope: false,
    isWip: false,
    suggestedSubjectPrefix: "feat(src): ",
  },
  messageValidation: { ok: false, violations: ["subject-too-long"] },
  preflightFindingCodes: ["detached-head"],
  policyOutcome: "approval-gated",
};

const OK: GitDeliveryMutationResponse = {
  schemaVersion: "1",
  status: "blocked",
  actionKind: "commit",
  blockReason: "message-policy",
  messageViolations: ["missing-conventional-prefix"],
};

function makeClient(): GovernedGitFlowClient {
  return {
    branchCreate: vi.fn(async () => OK),
    branchSwitch: vi.fn(async () => OK),
    stage: vi.fn(async () => OK),
    unstage: vi.fn(async () => OK),
    commitPreview: vi.fn(async () => PREVIEW),
    commitExecute: vi.fn(async () => OK),
  };
}

const PROJECT = "/home/me/repo";

describe("GovernedGitFlowCard — a11y (WCAG 2.2 AA)", () => {
  it("has no violations in the empty state", async () => {
    const { container } = render(<GovernedGitFlowCard client={makeClient()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the default flow state", async () => {
    const { container } = render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations once the preview is loaded", async () => {
    const { container } = render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("ggit-preview")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with a rendered outcome banner", async () => {
    const { container } = render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes a polite live region for async outcome announcements", () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    const live = screen.getByTestId("ggit-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
  });

  it("conveys the outcome status with a text label, not colour alone", async () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(screen.getByTestId("ggit-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-outcome")).toHaveTextContent("commit: Blocked");
  });

  it("names the suggested prefix and policy decision in text", async () => {
    render(<GovernedGitFlowCard projectId={PROJECT} client={makeClient()} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("ggit-policy")).toBeInTheDocument());
    expect(screen.getByTestId("ggit-suggested-prefix")).toHaveTextContent("feat(src):");
    expect(screen.getByTestId("ggit-policy")).toHaveTextContent("Policy: approval-gated");
  });
});
