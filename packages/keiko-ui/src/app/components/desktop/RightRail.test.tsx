import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RightRail } from "./RightRail";

describe("RightRail", () => {
  it("renders the right rail as a labeled complementary landmark", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "Workspace utilities" })).toBeInTheDocument();
  });
});

describe("RightRail — aria-pressed on tool buttons (WCAG 4.1.2)", () => {
  it("sets aria-pressed=false when the panel is closed", () => {
    render(<RightRail openTools={new Set()} onTool={vi.fn()} />);
    const inspectorBtn = screen.getByRole("button", { name: "Inspector" });
    expect(inspectorBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true when the panel is open", () => {
    render(<RightRail openTools={new Set(["inspector"])} onTool={vi.fn()} />);
    const inspectorBtn = screen.getByRole("button", { name: "Inspector" });
    expect(inspectorBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("reflects open state independently for each tool button", () => {
    render(<RightRail openTools={new Set(["activity"])} onTool={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Inspector" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
