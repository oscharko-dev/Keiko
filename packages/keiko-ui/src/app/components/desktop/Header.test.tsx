// uiux-fix F013 — header chrome behavior (C023/C059/C157/C291/C399):
// the window buttons are wired to the workspace API instead of being dead
// controls, the tab strip no longer advertises a non-existent tab model,
// and the project tab exposes its full name via title once truncated.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { Header } from "./Header";

function renderHeader(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  const props = {
    openPalette: vi.fn(),
    openCommandPalette: vi.fn(),
    onTileAll: vi.fn(),
    onSplitFront: vi.fn(),
    onCascade: vi.fn(),
    ...overrides,
  };
  render(<Header {...props} />);
  return props;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("Header window controls (C023)", () => {
  it("does not expose the Expand window control", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Expand window" })).not.toBeInTheDocument();
  });

  it("does not expose the Restore window control", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Restore window" })).not.toBeInTheDocument();
  });

  it("no longer announces a 'Minimize window' action (no minimize state exists)", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Minimize window" })).toBeNull();
  });
});

describe("Header release controls", () => {
  it("does not expose New or command-palette buttons in the header", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "New window" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open the command palette (Ctrl/⌘K)" }),
    ).not.toBeInTheDocument();
  });
});

describe("Header context control", () => {
  it("mounts task context controls inside the header chrome", () => {
    renderHeader({ contextControl: <button type="button">Task workspace</button> });

    const slot = document.querySelector(".hd-context");
    expect(slot).not.toBeNull();
    expect(slot).toContainElement(screen.getByRole("button", { name: "Task workspace" }));
  });
});

describe("Header editor selector", () => {
  it("does not expose the Preferred editor control in the header", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: /Preferred editor/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Editor:/)).not.toBeInTheDocument();
  });
});

describe("Header agent mode switch", () => {
  it("does not expose the Agent mode switch in the header", () => {
    renderHeader();
    expect(screen.queryByRole("group", { name: "Agent mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "You" })).not.toBeInTheDocument();
  });
});

describe("Header connection status", () => {
  it("does not expose the shell connection status pill in the header", () => {
    renderHeader();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(document.querySelector(".tb-status")).toBeNull();
  });
});

describe("Header split action wording (F039 C401)", () => {
  it("uses the CommandPalette's wording 'Split front windows' for tooltip and aria-label", () => {
    renderHeader();
    const btn = screen.getByRole("button", { name: "Split front windows" });
    expect(btn.getAttribute("data-tip")).toBe("Split front windows");
  });

  it("localizes header window-control labels when German is selected", () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <Header
          openPalette={vi.fn()}
          openCommandPalette={vi.fn()}
          onTileAll={vi.fn()}
          onSplitFront={vi.fn()}
          onCascade={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "Vordere Fenster teilen" })).toHaveAttribute(
      "data-tip",
      "Vordere Fenster teilen",
    );
  });
});

describe("Header tab strip", () => {
  it("renders no dead 'New tab' button (no tab model exists)", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  });

  it("does not expose the project tab in the header", () => {
    renderHeader();
    expect(document.querySelector(".tb-tabs")).toBeNull();
  });
});

describe("Header brand (C399)", () => {
  it("keeps the logo decorative next to the visible wordmark (no 'Keiko Keiko')", () => {
    const { container } = render(
      <Header
        openPalette={vi.fn()}
        openCommandPalette={vi.fn()}
        onTileAll={vi.fn()}
        onSplitFront={vi.fn()}
        onCascade={vi.fn()}
      />,
    );
    const logo = container.querySelector(".hd-logo");
    expect(logo?.getAttribute("alt")).toBe("");
  });
});
