// Issue #644 — the workspace Search input must carry an accessible name so screen-reader users
// can find it without relying on the visible icon/placeholder.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchPanel } from "./SearchPanel";

describe("SearchPanel — accessible name (issue #644)", () => {
  it("exposes the input via its aria-label", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("Search files and symbols");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("uses the search input type so the browser exposes a clear-button affordance", () => {
    render(<SearchPanel />);
    const input = screen.getByLabelText("Search files and symbols");
    expect(input).toHaveAttribute("type", "search");
  });
});

// uiux-fix F027 C040 — Search was an ornamental mock: a dead input, a fabricated
// ⇧⇧ shortcut chip, and the hardcoded PROJECT_TREE demo rendered under the real
// project name. Until real workspace search ships, the panel must be honest.
describe("SearchPanel — honest placeholder instead of fabricated mock (F027 C040)", () => {
  it("disables the input while search is not implemented", () => {
    render(<SearchPanel />);
    expect(screen.getByLabelText("Search files and symbols")).toBeDisabled();
  });

  it("does not render the fabricated demo project tree", () => {
    render(<SearchPanel />);
    expect(screen.queryByText("OrcaApplication.java")).toBeNull();
    expect(screen.queryByText("backend")).toBeNull();
  });

  it("does not advertise the unregistered double-shift shortcut", () => {
    render(<SearchPanel />);
    expect(screen.queryByText("⇧⇧")).toBeNull();
  });

  it("shows the established coming-soon placeholder copy", () => {
    render(<SearchPanel />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
