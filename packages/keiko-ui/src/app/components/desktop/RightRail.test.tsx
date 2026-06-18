import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RightRail } from "./RightRail";

describe("RightRail", () => {
  it("renders the right rail as a labeled complementary landmark", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "Workspace utilities" })).toBeInTheDocument();
  });

  it("renders only the workspace outline toggle in the right sidebar", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    const outline = screen.getByRole("button", { name: "Workspace outline" });
    expect(outline).toHaveAttribute("aria-pressed", "false");
    expect(outline).toHaveAttribute("aria-controls", "workspace-outline");
    expect(screen.queryByRole("button", { name: "Inspector" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resources" })).not.toBeInTheDocument();
  });

  it("mirrors outline state and toggles from the rail button", async () => {
    const onToggleOutline = vi.fn();
    const user = userEvent.setup();
    render(
      <RightRail
        openTools={new Set()}
        onTool={vi.fn()}
        outlineOpen={true}
        onToggleOutline={onToggleOutline}
      />,
    );

    const outline = screen.getByRole("button", { name: "Workspace outline" });
    expect(outline).toHaveAttribute("aria-pressed", "true");
    expect(outline).toHaveAttribute("data-active", "true");

    await user.click(outline);
    expect(onToggleOutline).toHaveBeenCalledTimes(1);
  });
});
