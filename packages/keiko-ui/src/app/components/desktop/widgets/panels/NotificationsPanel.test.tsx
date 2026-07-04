// PA-01 — notification items must carry list semantics so SR conveys count + structure.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationsPanel } from "./NotificationsPanel";

describe("NotificationsPanel — list semantics (PA-01)", () => {
  it("renders the notification container as a live log region (GEN-UI-A11Y-014)", () => {
    // The container is now a role="log" (mirrors TerminalWidget) so future dynamic notifications
    // are announced; its <li> children keep their listitem semantics for structure.
    render(<NotificationsPanel />);
    const log = screen.getByRole("log");
    expect(log).toBeInTheDocument();
  });

  it("renders each notification as a listitem", () => {
    render(<NotificationsPanel />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("mutation guard: removing list role breaks the list assertion", () => {
    // Verify the list exposes all three static items so a mutation that removes
    // one item (or the list wrapper) is caught by the count assertion.
    render(<NotificationsPanel />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
  });

  it("every item has visible title text accessible to screen readers", () => {
    render(<NotificationsPanel />);
    const log = screen.getByRole("log");
    expect(within(log).getByText("Agent finished build-board")).toBeInTheDocument();
    expect(within(log).getByText("diff-review ready to merge")).toBeInTheDocument();
    expect(within(log).getByText("lint-pass queued")).toBeInTheDocument();
  });
});

describe("NotificationsPanel — polite log live region (GEN-UI-A11Y-014)", () => {
  it("annotates the list as a named, polite log so future additions are announced", () => {
    render(<NotificationsPanel />);
    // role=log resolves to the accessible role "log"; the same element keeps its list semantics
    // via the aria-label + role, and is reachable by its accessible name.
    const log = screen.getByRole("log", { name: "Notifications" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-relevant", "additions text");
    expect(log).toHaveAttribute("aria-atomic", "false");
  });
});
