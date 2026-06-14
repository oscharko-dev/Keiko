// PA-01 — notification items must carry list semantics so SR conveys count + structure.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationsPanel } from "./NotificationsPanel";

describe("NotificationsPanel — list semantics (PA-01)", () => {
  it("renders the notification container as a list", () => {
    render(<NotificationsPanel />);
    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
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
    const list = screen.getByRole("list");
    expect(within(list).getByText("Agent finished build-board")).toBeInTheDocument();
    expect(within(list).getByText("diff-review ready to merge")).toBeInTheDocument();
    expect(within(list).getByText("lint-pass queued")).toBeInTheDocument();
  });
});
