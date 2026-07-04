// test-plan #35 — the NumberControlStepper exposes two accessibly-named buttons ("Increase <label>"
// / "Decrease <label>"), fires onStepUp/onStepDown on click, and respects the disabled state.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NumberControlStepper } from "./NumberControlStepper";

describe("NumberControlStepper — a11y + interaction (test-plan #35)", () => {
  it("exposes increase and decrease buttons with derived aria-labels", () => {
    render(<NumberControlStepper label="Opacity" onStepUp={() => {}} onStepDown={() => {}} />);
    expect(screen.getByRole("button", { name: "Increase Opacity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease Opacity" })).toBeInTheDocument();
  });

  it("fires onStepUp when the increase button is clicked", async () => {
    const user = userEvent.setup();
    const onStepUp = vi.fn();
    render(<NumberControlStepper label="Opacity" onStepUp={onStepUp} onStepDown={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Increase Opacity" }));
    expect(onStepUp).toHaveBeenCalledTimes(1);
  });

  it("fires onStepDown when the decrease button is clicked", async () => {
    const user = userEvent.setup();
    const onStepDown = vi.fn();
    render(<NumberControlStepper label="Opacity" onStepUp={() => {}} onStepDown={onStepDown} />);
    await user.click(screen.getByRole("button", { name: "Decrease Opacity" }));
    expect(onStepDown).toHaveBeenCalledTimes(1);
  });

  it("respects the disabled state on both buttons and does not fire handlers", async () => {
    const user = userEvent.setup();
    const onStepUp = vi.fn();
    const onStepDown = vi.fn();
    render(
      <NumberControlStepper label="Opacity" disabled onStepUp={onStepUp} onStepDown={onStepDown} />,
    );
    const increase = screen.getByRole("button", { name: "Increase Opacity" });
    const decrease = screen.getByRole("button", { name: "Decrease Opacity" });
    expect(increase).toBeDisabled();
    expect(decrease).toBeDisabled();
    await user.click(increase);
    await user.click(decrease);
    expect(onStepUp).not.toHaveBeenCalled();
    expect(onStepDown).not.toHaveBeenCalled();
  });
});
