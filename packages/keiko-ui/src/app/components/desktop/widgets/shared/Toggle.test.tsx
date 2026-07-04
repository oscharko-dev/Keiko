// GEN-UI-A11Y-020 / test-plan #36 — the shared Toggle is a role="switch" that MUST always carry a
// resolvable accessible name and must toggle aria-checked while emitting the negated value.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

describe("Toggle — accessible switch semantics (GEN-UI-A11Y-020)", () => {
  it("renders a role=switch with a resolvable accessible name from the label prop", () => {
    render(<Toggle on={false} onChange={() => {}} label="Wallpaper" />);
    const sw = screen.getByRole("switch", { name: "Wallpaper" });
    expect(sw).toBeInTheDocument();
  });

  it("reflects the on state via aria-checked", () => {
    const { rerender } = render(<Toggle on={false} onChange={() => {}} label="Wallpaper" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    rerender(<Toggle on onChange={() => {}} label="Wallpaper" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("emits the negated value when toggled from off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} label="Wallpaper" />);
    await user.click(screen.getByRole("switch", { name: "Wallpaper" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("emits the negated value when toggled from on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle on onChange={onChange} label="Wallpaper" />);
    await user.click(screen.getByRole("switch", { name: "Wallpaper" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("resolves its accessible name from an external label via aria-labelledby", () => {
    render(
      <>
        <span id="tg-label">Use in chat</span>
        <Toggle on={false} onChange={() => {}} aria-labelledby="tg-label" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Use in chat" })).toBeInTheDocument();
  });
});
