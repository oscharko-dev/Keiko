import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RightRail } from "./RightRail";

describe("RightRail", () => {
  it("does not expose an empty named complementary landmark", () => {
    // GEN-UI-A11Y-025 — the empty layout spacer must not advertise a labelled complementary region
    // with no content, so it renders as a plain <div> with no landmark role/name.
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Workspace utilities" }),
    ).not.toBeInTheDocument();
  });

  it("does not expose removed workspace utility buttons", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Workspace outline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspector" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resources" })).not.toBeInTheDocument();
  });
});
