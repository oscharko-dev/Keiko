// uiux-fix F013 — header chrome behavior (C023/C059/C157/C291/C399):
// the window buttons are wired to the workspace API instead of being dead
// controls, the tab strip no longer advertises a non-existent tab model,
// and the project tab exposes its full name via title once truncated.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

function renderHeader(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  const props = {
    mode: "manual" as const,
    projectName: "tender-kare-d0d488",
    statusLabel: "Connected",
    statusTone: "ok" as const,
    onModeChange: vi.fn(),
    openPalette: vi.fn(),
    openCommandPalette: vi.fn(),
    onTileAll: vi.fn(),
    onSplitFront: vi.fn(),
    onCascade: vi.fn(),
    onExpandFront: vi.fn(),
    onRestoreFront: vi.fn(),
    ...overrides,
  };
  render(<Header {...props} />);
  return props;
}

describe("Header window controls (C023)", () => {
  it("invokes onExpandFront when the expand button is clicked", async () => {
    const user = userEvent.setup();
    const props = renderHeader();
    await user.click(screen.getByRole("button", { name: "Expand window" }));
    expect(props.onExpandFront).toHaveBeenCalledTimes(1);
    expect(props.onRestoreFront).not.toHaveBeenCalled();
  });

  it("invokes onRestoreFront when the restore button is clicked", async () => {
    const user = userEvent.setup();
    const props = renderHeader();
    await user.click(screen.getByRole("button", { name: "Restore window" }));
    expect(props.onRestoreFront).toHaveBeenCalledTimes(1);
    expect(props.onExpandFront).not.toHaveBeenCalled();
  });

  it("no longer announces a 'Minimize window' action (no minimize state exists)", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Minimize window" })).toBeNull();
  });
});

// uiux-fix F039 C223 — the command palette used to be reachable only via the
// Cmd/Ctrl+K chord (a hover tooltip was the sole hint). The header now exposes a
// visible, clickable ⌘K entry point.
describe("Header command-palette entry point (F039 C223)", () => {
  it("renders a visible ⌘K button that opens the command palette", async () => {
    const user = userEvent.setup();
    const props = renderHeader();
    const btn = screen.getByRole("button", { name: "Open the command palette (Ctrl/⌘K)" });
    expect(btn.textContent).toContain("⌘K");
    await user.click(btn);
    expect(props.openCommandPalette).toHaveBeenCalledTimes(1);
    // The "New" window picker is a different surface — it must not be triggered.
    expect(props.openPalette).not.toHaveBeenCalled();
  });
});

describe("Header split action wording (F039 C401)", () => {
  it("uses the CommandPalette's wording 'Split front windows' for title and aria-label", () => {
    renderHeader();
    const btn = screen.getByRole("button", { name: "Split front windows" });
    expect(btn.getAttribute("title")).toBe("Split front windows");
  });
});

describe("Header tab strip (C059/C291/C157)", () => {
  it("renders no dead 'New tab' button (no tab model exists)", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  });

  it("exposes the full project name via the tab's title attribute", () => {
    renderHeader({ projectName: "conversation-center-hardening-worktree" });
    const label = screen.getByText("conversation-center-hardening-worktree");
    expect(label.closest(".tb-tab")?.getAttribute("title")).toBe(
      "conversation-center-hardening-worktree",
    );
  });
});

describe("Header brand (C399)", () => {
  it("keeps the logo decorative next to the visible wordmark (no 'Keiko Keiko')", () => {
    const { container } = render(
      <Header
        mode="manual"
        projectName="Keiko"
        statusLabel="Connected"
        statusTone="ok"
        onModeChange={vi.fn()}
        openPalette={vi.fn()}
        openCommandPalette={vi.fn()}
        onTileAll={vi.fn()}
        onSplitFront={vi.fn()}
        onCascade={vi.fn()}
        onExpandFront={vi.fn()}
        onRestoreFront={vi.fn()}
      />,
    );
    const logo = container.querySelector(".hd-logo");
    expect(logo?.getAttribute("alt")).toBe("");
  });
});
