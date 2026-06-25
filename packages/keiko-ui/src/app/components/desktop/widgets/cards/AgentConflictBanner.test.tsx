/**
 * Tests for AgentConflictBanner (Issue #1394, ADR-0058 D4).
 *
 * Covers: role=alert + data-testid; ai-danger class; all six conflict codes; correct
 * affordance groups per code (Save/Dismiss, Reload/Dismiss, Dismiss-only); handler
 * wiring; and jest-axe a11y for each code variant.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AgentConflictBanner, type AgentConflictCode } from "./AgentConflictBanner";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderBanner(
  code: AgentConflictCode,
  overrides: {
    message?: string;
    onSave?: () => void;
    onReload?: () => void;
    onDismiss?: () => void;
  } = {},
) {
  const onDismiss = overrides.onDismiss ?? vi.fn();
  return {
    onDismiss,
    ...render(
      <AgentConflictBanner
        code={code}
        message={overrides.message ?? `Test message for ${code}`}
        onSave={overrides.onSave}
        onReload={overrides.onReload}
        onDismiss={onDismiss}
      />,
    ),
  };
}

// ─── Structure & ARIA ────────────────────────────────────────────────────────

describe("AgentConflictBanner — structure", () => {
  it("renders role=alert so screen readers announce the conflict", () => {
    renderBanner("DIRTY");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("has data-testid=agent-conflict-banner for test targeting", () => {
    renderBanner("DIRTY");
    expect(screen.getByTestId("agent-conflict-banner")).toBeInTheDocument();
  });

  it("contains the ai-danger class for visual danger treatment", () => {
    renderBanner("DIRTY");
    const banner = screen.getByTestId("agent-conflict-banner");
    expect(banner.className).toMatch(/ai-danger/);
  });

  it("renders the conflict code in the body", () => {
    renderBanner("INVALID_EDITS");
    expect(screen.getByTestId("agent-conflict-banner")).toHaveTextContent("INVALID_EDITS");
  });

  it("renders the message text in the body", () => {
    renderBanner("OUT_OF_SCOPE", { message: "The file escapes the workspace." });
    expect(screen.getByTestId("agent-conflict-banner")).toHaveTextContent(
      "The file escapes the workspace.",
    );
  });

  it("renders without crashing for an empty message", () => {
    renderBanner("NO_ACTIVE_SESSION", { message: "" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

// ─── DIRTY: Save + Dismiss ───────────────────────────────────────────────────

describe("AgentConflictBanner — DIRTY affordances", () => {
  it("renders Save and Dismiss buttons for DIRTY", () => {
    renderBanner("DIRTY", { onSave: vi.fn() });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("calls onSave when Save is clicked", async () => {
    const onSave = vi.fn();
    renderBanner("DIRTY", { onSave });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when Dismiss is clicked for DIRTY", async () => {
    const onSave = vi.fn();
    const onDismiss = vi.fn();
    renderBanner("DIRTY", { onSave, onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not render Reload for DIRTY", () => {
    renderBanner("DIRTY", { onSave: vi.fn() });
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});

// ─── VERSION_MISMATCH: Reload + Dismiss ──────────────────────────────────────

describe("AgentConflictBanner — VERSION_MISMATCH affordances", () => {
  it("renders Reload and Dismiss buttons for VERSION_MISMATCH", () => {
    renderBanner("VERSION_MISMATCH", { onReload: vi.fn() });
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("calls onReload when Reload is clicked", async () => {
    const onReload = vi.fn();
    renderBanner("VERSION_MISMATCH", { onReload });
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when Dismiss is clicked for VERSION_MISMATCH", async () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    renderBanner("VERSION_MISMATCH", { onReload, onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("does not render Save for VERSION_MISMATCH", () => {
    renderBanner("VERSION_MISMATCH", { onReload: vi.fn() });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

// ─── CONTENT_HASH_MISMATCH: Reload + Dismiss ─────────────────────────────────

describe("AgentConflictBanner — CONTENT_HASH_MISMATCH affordances", () => {
  it("renders Reload and Dismiss buttons for CONTENT_HASH_MISMATCH", () => {
    renderBanner("CONTENT_HASH_MISMATCH", { onReload: vi.fn() });
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("calls onReload when Reload is clicked for CONTENT_HASH_MISMATCH", async () => {
    const onReload = vi.fn();
    renderBanner("CONTENT_HASH_MISMATCH", { onReload });
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when Dismiss is clicked for CONTENT_HASH_MISMATCH", async () => {
    const onDismiss = vi.fn();
    renderBanner("CONTENT_HASH_MISMATCH", { onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ─── INVALID_EDITS: Dismiss only ─────────────────────────────────────────────

describe("AgentConflictBanner — INVALID_EDITS affordances", () => {
  it("renders only Dismiss for INVALID_EDITS (agent error, user cannot self-resolve)", () => {
    renderBanner("INVALID_EDITS");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("calls onDismiss when Dismiss is clicked for INVALID_EDITS", async () => {
    const onDismiss = vi.fn();
    renderBanner("INVALID_EDITS", { onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ─── OUT_OF_SCOPE: Dismiss only ──────────────────────────────────────────────

describe("AgentConflictBanner — OUT_OF_SCOPE affordances", () => {
  it("renders only Dismiss for OUT_OF_SCOPE (agent error, user cannot self-resolve)", () => {
    renderBanner("OUT_OF_SCOPE");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("calls onDismiss when Dismiss is clicked for OUT_OF_SCOPE", async () => {
    const onDismiss = vi.fn();
    renderBanner("OUT_OF_SCOPE", { onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ─── NO_ACTIVE_SESSION: Dismiss only ─────────────────────────────────────────

describe("AgentConflictBanner — NO_ACTIVE_SESSION affordances", () => {
  it("renders only Dismiss for NO_ACTIVE_SESSION", () => {
    renderBanner("NO_ACTIVE_SESSION");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});

// ─── Accessibility (jest-axe) ─────────────────────────────────────────────────

describe("AgentConflictBanner — accessibility (jest-axe)", () => {
  const allCodes: AgentConflictCode[] = [
    "DIRTY",
    "VERSION_MISMATCH",
    "CONTENT_HASH_MISMATCH",
    "INVALID_EDITS",
    "OUT_OF_SCOPE",
    "NO_ACTIVE_SESSION",
  ];

  it.each(allCodes)("has no axe violations for code %s", async (code) => {
    const { container } = render(
      <AgentConflictBanner
        code={code}
        message="Test accessibility violation check."
        onSave={vi.fn()}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
