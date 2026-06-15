import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RightRail } from "./RightRail";

describe("RightRail", () => {
  it("renders the right rail as a labeled complementary landmark", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "Workspace utilities" })).toBeInTheDocument();
  });

  it("does not expose utility icon buttons in the right sidebar", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Inspector" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resources" })).not.toBeInTheDocument();
  });
});
