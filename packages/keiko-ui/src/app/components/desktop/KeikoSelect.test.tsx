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

    expect(screen.getByRole("listbox", { name: "Policy profile" })).toBeInTheDocument();

    const menu = document.querySelector(".ksel-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveStyle({
      left: "64px",
      top: "141px",
      width: "240px",
    });
    expect(menu?.getAttribute("style")).toContain("--ksel-option-height: 30px");
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
    const option = screen.getByRole("option", {
      name: "gpt-4o-mini-search-preview-2025-03-11",
    });
    vi.spyOn(option, "getBoundingClientRect").mockReturnValue({
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
    const label = screen.getAllByText("gpt-4o-mini-search-preview-2025-03-11")[1]!;
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 280 },
    });

    fireEvent.pointerEnter(option);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("gpt-4o-mini-search-preview-2025-03-11");
    expect(tooltip).toHaveAttribute("data-placement", "top-left");
    expect(tooltip).toHaveStyle({ left: "160px", top: "100px" });

    fireEvent.pointerLeave(option);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });

  it("mirrors long-label tooltips to the option's top-left edge near the viewport edge", async () => {
    const user = userEvent.setup();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    try {
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
        left: 180,
        right: 340,
        top: 48,
        width: 160,
        x: 180,
        y: 48,
        toJSON: () => ({}),
      });

      await user.click(trigger);
      vi.useFakeTimers();
      const option = screen.getByRole("option", {
        name: "gpt-4o-mini-search-preview-2025-03-11",
      });
      vi.spyOn(option, "getBoundingClientRect").mockReturnValue({
        bottom: 130,
        height: 24,
        left: 220,
        right: 336,
        top: 106,
        width: 116,
        x: 220,
        y: 106,
        toJSON: () => ({}),
      });
      const label = screen.getAllByText("gpt-4o-mini-search-preview-2025-03-11")[1]!;
      Object.defineProperties(label, {
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, value: 280 },
      });

      fireEvent.pointerEnter(option);
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveAttribute("data-placement", "top-right");
      expect(tooltip).toHaveStyle({ left: "212px", top: "100px" });
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });
});

describe("KeikoSelect interactions", () => {
  const sections = [
    {
      label: "Strategy",
      options: [
        { value: "model", label: "Model only" },
        { value: "files", label: "Live Files context" },
        { value: "disabled", label: "Disabled option", disabled: true },
      ],
    },
  ];

  it("commits the active option with keyboard navigation and returns focus to the trigger", async () => {
    const onValueChange = vi.fn();
    render(
      <KeikoSelect
        ariaLabel="Strategy"
        menuTitle="Strategy"
        onValueChange={onValueChange}
        sections={sections}
        value="model"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Strategy" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("option", { name: "Model only" });

    fireEvent.keyDown(screen.getByRole("option", { name: "Model only" }), { key: "ArrowDown" });
    const filesOption = screen.getByRole("option", { name: "Live Files context" });
    expect(filesOption).toHaveFocus();

    fireEvent.keyDown(filesOption, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("files");
    expect(screen.queryByRole("option", { name: "Live Files context" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("supports typeahead, Home, End, Tab, and Escape without entering disabled options", async () => {
    const user = userEvent.setup();
    render(
      <KeikoSelect
        ariaLabel="Strategy"
        menuTitle="Strategy"
        onValueChange={vi.fn()}
        sections={sections}
        value="model"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Strategy" });
    await user.click(trigger);

    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByRole("option", { name: "Live Files context" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("option", { name: "Live Files context" }), { key: "End" });
    expect(screen.getByRole("option", { name: "Live Files context" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("option", { name: "Live Files context" }), { key: "Home" });
    expect(screen.getByRole("option", { name: "Model only" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("option", { name: "Model only" }), { key: "Tab" });
    expect(screen.queryByRole("option", { name: "Model only" })).toBeNull();

    await user.click(trigger);
    fireEvent.keyDown(screen.getByRole("option", { name: "Model only" }), { key: "Escape" });
    expect(screen.queryByRole("option", { name: "Model only" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("ignores disabled triggers and disabled option commits", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <KeikoSelect
        ariaLabel="Strategy"
        disabled
        onValueChange={onValueChange}
        sections={sections}
        value="model"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Strategy" }));
    expect(screen.queryByRole("option", { name: "Model only" })).toBeNull();

    rerender(
      <KeikoSelect
        ariaLabel="Strategy"
        onValueChange={onValueChange}
        sections={sections}
        value="disabled"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Strategy" });
    await user.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Disabled option" }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Disabled option" })).toBeVisible();
  });

  it("closes on outside pointer and window blur while keeping optional chrome removable", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <KeikoSelect
          ariaLabel="Strategy"
          menuCountLabel="2 choices"
          onValueChange={vi.fn()}
          sections={sections}
          showMenuHeader={false}
          value="model"
        />
      </div>,
    );

    const trigger = screen.getByRole("combobox", { name: "Strategy" });
    await user.click(trigger);
    expect(screen.queryByText("2 choices")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("option", { name: "Model only" })).toBeNull();

    await user.click(trigger);
    fireEvent.blur(window);
    expect(screen.queryByRole("option", { name: "Model only" })).toBeNull();
  });
});
