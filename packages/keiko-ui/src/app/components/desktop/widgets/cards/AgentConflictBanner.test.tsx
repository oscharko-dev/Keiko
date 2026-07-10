/**
 * Tests for AgentConflictBanner (Issue #1394, ADR-0058 D4).
 *
 * Covers: role=alert + data-testid; ai-danger class; representative conflict codes across each
 * affordance group (Save/Dismiss, Reload/Dismiss, Dismiss-only), including the Issue #1392
 * NO_ACTIVE_BRIDGE code; handler wiring; and jest-axe a11y for each code variant.
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
  it("renders role=alertdialog so screen readers announce the conflict and expect an action", () => {
    renderBanner("DIRTY");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
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
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
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

// ─── NO_ACTIVE_BRIDGE: Dismiss only (Issue #1392) ────────────────────────────

describe("AgentConflictBanner — NO_ACTIVE_BRIDGE affordances", () => {
  it("renders the title and only Dismiss for NO_ACTIVE_BRIDGE", () => {
    renderBanner("NO_ACTIVE_BRIDGE", { message: "No live browser bridge is connected." });
    expect(screen.getByText("No live editor bridge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});

// ─── PRECONDITION_REQUIRED: Dismiss only (Issue #1391 AC2/AC3) ────────────────

describe("AgentConflictBanner — PRECONDITION_REQUIRED affordances", () => {
  it("renders the title and only Dismiss for PRECONDITION_REQUIRED", () => {
    renderBanner("PRECONDITION_REQUIRED", { message: "Write actions require a precondition." });
    expect(screen.getByText("Missing write precondition")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("calls onDismiss when Dismiss is clicked for PRECONDITION_REQUIRED", async () => {
    const onDismiss = vi.fn();
    renderBanner("PRECONDITION_REQUIRED", { onDismiss });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("AgentConflictBanner — policy affordances", () => {
  it.each([
    ["POLICY_DENIED", "Action denied by policy"],
    ["APPROVAL_REQUIRED", "Action approval required"],
  ] as const)("renders the bounded title and only Dismiss for %s", (code, title) => {
    renderBanner(code);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});

// ─── Focus + Escape (GEN-UI-A11Y-005) ────────────────────────────────────────

describe("AgentConflictBanner — focus + keyboard (GEN-UI-A11Y-005)", () => {
  it("focuses Save on mount for DIRTY (primary recovery action)", () => {
    renderBanner("DIRTY", { onSave: vi.fn() });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("focuses Reload on mount for VERSION_MISMATCH (primary recovery action)", () => {
    renderBanner("VERSION_MISMATCH", { onReload: vi.fn() });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reload" }));
  });

  it("focuses Dismiss on mount when it is the sole action (INVALID_EDITS)", () => {
    renderBanner("INVALID_EDITS");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("calls onDismiss when Escape is pressed inside the banner", async () => {
    const onDismiss = vi.fn();
    renderBanner("DIRTY", { onSave: vi.fn(), onDismiss });
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss on Escape for a dismiss-only conflict (VERSION_MISMATCH omitted onReload)", async () => {
    const onDismiss = vi.fn();
    renderBanner("OUT_OF_SCOPE", { onDismiss });
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
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
    "NO_ACTIVE_BRIDGE",
    "PRECONDITION_REQUIRED",
    "POLICY_DENIED",
    "APPROVAL_REQUIRED",
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
