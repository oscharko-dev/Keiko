import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { ToolRail } from "./ToolRail";

describe("ToolRail", () => {
  it("renders aside with accessible name 'Workspace tools'", () => {
    render(<ToolRail />);
    expect(screen.getByRole("complementary", { name: /workspace tools/i })).toBeInTheDocument();
  });

  it("renders 4 disabled buttons", () => {
    render(<ToolRail />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it("each button has an associated tooltip", () => {
    render(<ToolRail />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      const tipId = btn.getAttribute("aria-describedby");
      expect(tipId).not.toBeNull();
      const tip = document.getElementById(tipId ?? "");
      expect(tip).not.toBeNull();
      expect(tip?.textContent).toMatch(/available in a later release/i);
    }
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<ToolRail />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
