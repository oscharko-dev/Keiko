// Issue #644 — Mode Switch buttons must expose `aria-pressed` so assistive tech can read the
// active mode (Manual/You vs Autonomous/Keiko). Visual data-on is unchanged for CSS styling.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "./ModeSwitch";

describe("ModeSwitch — aria-pressed (issue #644)", () => {
  it("marks the manual button as pressed when mode is manual", () => {
    render(<ModeSwitch mode="manual" onChange={vi.fn()} />);
    const youButton = screen.getByRole("button", { name: /You/ });
    const keikoButton = screen.getByRole("button", { name: /Keiko/ });
    expect(youButton).toHaveAttribute("aria-pressed", "true");
    expect(keikoButton).toHaveAttribute("aria-pressed", "false");
  });

  it("marks the autonomous button as pressed when mode is autonomous", () => {
    render(<ModeSwitch mode="autonomous" onChange={vi.fn()} />);
    const youButton = screen.getByRole("button", { name: /You/ });
    const keikoButton = screen.getByRole("button", { name: /Keiko/ });
    expect(youButton).toHaveAttribute("aria-pressed", "false");
    expect(keikoButton).toHaveAttribute("aria-pressed", "true");
  });

  it("invokes onChange when the inactive button is pressed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModeSwitch mode="manual" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Keiko/ }));
    expect(onChange).toHaveBeenCalledWith("autonomous");
  });

  it("wraps the buttons in a labelled group", () => {
    render(<ModeSwitch mode="manual" onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Agent mode" })).toBeInTheDocument();
  });
});
