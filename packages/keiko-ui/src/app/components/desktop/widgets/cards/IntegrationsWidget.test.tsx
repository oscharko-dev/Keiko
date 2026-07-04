// GEN-UI-TEST-GAP-011 / test-plan #29 — the IntegrationsWidget is an honest, non-interactive
// overview: a named list with one row per app, each showing "Not connected — coming soon", and NO
// fabricated interactivity (no buttons, links, or aria-pressed) since no integration backend exists.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsWidget } from "./IntegrationsWidget";

describe("IntegrationsWidget — honest non-interactive overview (GEN-UI-TEST-GAP-011)", () => {
  it("renders a list named Integrations with one row per app", () => {
    render(<IntegrationsWidget />);
    const list = screen.getByRole("list", { name: "Integrations" });
    expect(list).toBeInTheDocument();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows the 'Not connected — coming soon' status on every row", () => {
    render(<IntegrationsWidget />);
    const list = screen.getByRole("list", { name: "Integrations" });
    const rows = within(list).getAllByRole("listitem");
    for (const row of rows) {
      expect(within(row).getByText("Not connected — coming soon")).toBeInTheDocument();
    }
  });

  it("does NOT fabricate interactivity — no buttons, links, or aria-pressed", () => {
    const { container } = render(<IntegrationsWidget />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("[aria-pressed]")).toBeNull();
  });
});
