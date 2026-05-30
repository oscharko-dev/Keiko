// Tests for PlannedToolPanel (issue #67).
// Covers: title per variant, follow-up link, target/rel, close button, axe-clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { ProjectWithAvailability } from "@/lib/types";
import { PlannedToolPanel } from "./PlannedToolPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

const FOLLOW_UP_URL = "https://github.com/oscharko-dev/Keiko/issues/99";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlannedToolPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Title per variant ─────────────────────────────────────────────────────

  it("renders 'Browser' as heading for browser tool", () => {
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    expect(screen.getByRole("heading", { name: "Browser" })).toBeInTheDocument();
  });

  it("renders 'Review' as heading for review tool", () => {
    render(
      <PlannedToolPanel
        tool="review"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
  });

  it("renders 'Terminal' as heading for terminal tool", () => {
    render(
      <PlannedToolPanel
        tool="terminal"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeInTheDocument();
  });

  // ── Follow-up link ────────────────────────────────────────────────────────

  it("renders follow-up link with the provided URL", () => {
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    const link = screen.getByRole("link", { name: /follow-up issue/i });
    expect(link).toHaveAttribute("href", FOLLOW_UP_URL);
  });

  it("follow-up link has target=_blank and rel=noopener noreferrer", () => {
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    const link = screen.getByRole("link", { name: /follow-up issue/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("follow-up link accessible name conveys 'opens in new tab'", () => {
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    const link = screen.getByRole("link", { name: /follow-up issue/i });
    expect(link.getAttribute("aria-label")).toMatch(/opens in new tab/i);
  });

  it("renders placeholder message when followUpIssueUrl is empty", () => {
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl=""
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/follow-up issue will be linked/i)).toBeInTheDocument();
  });

  // ── Close button ─────────────────────────────────────────────────────────

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={onClose}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    await user.click(screen.getByRole("button", { name: /close browser panel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Axe ──────────────────────────────────────────────────────────────────

  it("has no axe violations for browser variant", async () => {
    const { container } = render(
      <PlannedToolPanel
        tool="browser"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations for review variant", async () => {
    const { container } = render(
      <PlannedToolPanel
        tool="review"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl={FOLLOW_UP_URL}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations for terminal variant", async () => {
    const { container } = render(
      <PlannedToolPanel
        tool="terminal"
        project={project}
        onClose={() => { /* noop */ }}
        followUpIssueUrl=""
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
