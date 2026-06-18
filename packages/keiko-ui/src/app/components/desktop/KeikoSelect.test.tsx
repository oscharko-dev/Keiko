import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import KeikoSelect from "./KeikoSelect";

describe("KeikoSelect menu geometry", () => {
  it("matches the trigger width and exposes trigger-height option sizing", async () => {
    const user = userEvent.setup();
    render(
      <KeikoSelect
        ariaLabel="Policy profile"
        menuMinWidth={420}
        menuTitle="Policy profile"
        onValueChange={vi.fn()}
        sections={[
          {
            options: [
              { value: "regression", label: "Regression" },
              { value: "banking", label: "Banking" },
            ],
          },
        ]}
        value="regression"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Policy profile" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 142,
      height: 42,
      left: 64,
      right: 304,
      top: 100,
      width: 240,
      x: 64,
      y: 100,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const menu = document.querySelector(".ksel-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveStyle({
      left: "64px",
      top: "141px",
      width: "240px",
    });
    expect(menu?.getAttribute("style")).toContain("--ksel-option-height: 42px");
    expect(menu).toHaveClass("ksel-menu-open-down");
    expect(trigger).toHaveClass("ksel-trigger-open-down");
  });

  it("uses a readable popover width for icon-sized triggers", async () => {
    const user = userEvent.setup();
    render(
      <KeikoSelect
        ariaLabel="Models"
        menuMinWidth={280}
        menuTitle="Models"
        onValueChange={vi.fn()}
        sections={[
          {
            options: [
              { value: "gpt-4.1", label: "gpt-4.1" },
              { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
            ],
          },
        ]}
        value="gpt-4.1"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Models" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 82,
      height: 34,
      left: 24,
      right: 58,
      top: 48,
      width: 34,
      x: 24,
      y: 48,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const menu = document.querySelector(".ksel-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveStyle({
      left: "24px",
      top: "88px",
      width: "280px",
    });
    expect(menu).not.toHaveClass("ksel-menu-attached");
    expect(trigger).not.toHaveClass("ksel-trigger-open-down");
  });

  it("can use the normal model pill width for icon-sized model triggers", async () => {
    const user = userEvent.setup();
    render(
      <KeikoSelect
        ariaLabel="Models"
        menuMinWidth={184}
        menuTitle="Models"
        onValueChange={vi.fn()}
        sections={[
          {
            options: [
              { value: "gpt-3.5-turbo", label: "gpt-3.5-turbo" },
              { value: "gpt-4", label: "gpt-4" },
            ],
          },
        ]}
        value="gpt-3.5-turbo"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Models" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 82,
      height: 34,
      left: 24,
      right: 58,
      top: 48,
      width: 34,
      x: 24,
      y: 48,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const menu = document.querySelector(".ksel-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveStyle({
      left: "24px",
      top: "88px",
      width: "184px",
    });
    expect(menu).not.toHaveClass("ksel-menu-attached");
  });

  it("shows full option labels only after a delayed hover when text is truncated", async () => {
    const user = userEvent.setup();
    render(
      <KeikoSelect
        ariaLabel="Models"
        menuTitle="Models"
        onValueChange={vi.fn()}
        sections={[
          {
            options: [
              {
                value: "gpt-4o-mini-search-preview-2025-03-11",
                label: "gpt-4o-mini-search-preview-2025-03-11",
              },
            ],
          },
        ]}
        value="gpt-4o-mini-search-preview-2025-03-11"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Models" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 82,
      height: 34,
      left: 24,
      right: 208,
      top: 48,
      width: 184,
      x: 24,
      y: 48,
      toJSON: () => ({}),
    });

    await user.click(trigger);
    vi.useFakeTimers();
    const label = screen.getAllByText("gpt-4o-mini-search-preview-2025-03-11")[1]!;
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 280 },
    });
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue({
      bottom: 130,
      height: 24,
      left: 32,
      right: 152,
      top: 106,
      width: 120,
      x: 32,
      y: 106,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(label);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent("gpt-4o-mini-search-preview-2025-03-11");

    fireEvent.pointerLeave(label);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });
});
