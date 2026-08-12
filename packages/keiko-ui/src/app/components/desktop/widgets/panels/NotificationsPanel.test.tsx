// KEIKO-0158 — Notifications is an honest placeholder: no notification source is wired
// behind it, so it must not present hardcoded, never-changing entries as live-list content.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationsPanel } from "./NotificationsPanel";

describe("NotificationsPanel", () => {
  it("shows an explicit empty state instead of a fake, never-changing notification list", () => {
    render(<NotificationsPanel />);

    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });

  it("renders none of the old hardcoded, never-changing notification entries", () => {
    render(<NotificationsPanel />);

    expect(screen.queryByText("Agent finished build-board")).not.toBeInTheDocument();
    expect(screen.queryByText("diff-review ready to merge")).not.toBeInTheDocument();
    expect(screen.queryByText("lint-pass queued")).not.toBeInTheDocument();
  });

  it("does not present static content inside an aria-live list", () => {
    render(<NotificationsPanel />);

    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
