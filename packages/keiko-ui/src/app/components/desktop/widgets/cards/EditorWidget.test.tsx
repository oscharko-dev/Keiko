import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorWidget } from "./EditorWidget";

// uiux-fix F020 C050/C352 — the editor card is an honest static demo: no dead
// pseudo-tab, a visible placeholder note, and the file prop only labels the tab.
describe("EditorWidget", () => {
  it("renders a visible static-demo note instead of impersonating a working editor", () => {
    render(<EditorWidget />);
    expect(screen.getByRole("note")).toHaveTextContent(/static demo/i);
    expect(screen.getByRole("note")).toHaveTextContent(/file editing isn't available yet/i);
  });

  it("does not render the dead non-interactive styles.css pseudo-tab", () => {
    render(<EditorWidget />);
    expect(screen.queryByText("styles.css")).not.toBeInTheDocument();
  });

  it("uses the file prop as the tab label", () => {
    render(<EditorWidget file="api.ts" />);
    expect(screen.getByText(/api\.ts/)).toBeInTheDocument();
  });

  it("falls back to the default tab label", () => {
    render(<EditorWidget />);
    expect(screen.getByText(/windows\.jsx/)).toBeInTheDocument();
  });

  it("exposes the code pane as a focusable labelled region for keyboard scrolling (C194)", () => {
    render(<EditorWidget file="api.ts" />);
    const region = screen.getByRole("region", { name: "Code preview: api.ts" });
    expect(region).toHaveAttribute("tabindex", "0");
  });
});
