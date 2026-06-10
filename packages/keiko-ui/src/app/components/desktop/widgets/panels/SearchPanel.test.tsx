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
