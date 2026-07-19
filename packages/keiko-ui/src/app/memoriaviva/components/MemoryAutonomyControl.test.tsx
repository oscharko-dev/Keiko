import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { MemoryAutonomyControl } from "./MemoryAutonomyControl";

function renderControl(props: {
  readonly mode?: CodingWorkbenchMode;
  readonly effectiveMode?: CodingWorkbenchMode | null;
  readonly disabled?: boolean;
  readonly error?: "hydrate" | "persist" | null;
  readonly onChange?: (mode: CodingWorkbenchMode) => void;
}): ReturnType<typeof render> {
  return render(
    <MemoryAutonomyControl
      mode={props.mode ?? "governed-assist"}
      effectiveMode={props.effectiveMode ?? null}
      disabled={props.disabled ?? false}
      error={props.error ?? null}
      onChange={props.onChange ?? vi.fn()}
    />,
  );
}

describe("MemoryAutonomyControl", () => {
  it("renders exactly the three ADR-0129 modes as an accessible radiogroup", () => {
    renderControl({ mode: "supervised-coding" });
    const group = screen.getByRole("radiogroup", { name: "Memory autonomy mode" });
    const options = within(group).getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: /Ask for approval/ })).toBeInTheDocument();
    const selected = within(group).getByRole("radio", { name: /Supervised workspace/ });
    expect(selected).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Full access/ })).not.toBeChecked();
  });

  it("calls onChange with the selected mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControl({ mode: "governed-assist", onChange });
    await user.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(onChange).toHaveBeenCalledWith("autonomous-delivery");
  });

  it("disables every option while pending", () => {
    renderControl({ disabled: true });
    for (const option of screen.getAllByRole("radio")) {
      expect(option).toBeDisabled();
    }
  });

  it("surfaces the hydrate and persist error copy as an alert", () => {
    const { rerender } = renderControl({ error: "hydrate" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The memory autonomy mode could not be loaded. Ask for approval remains active.",
    );
    rerender(
      <MemoryAutonomyControl
        mode="governed-assist"
        effectiveMode={null}
        disabled={false}
        error="persist"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The memory autonomy mode could not be saved. The previous mode remains active.",
    );
  });

  it("shows no clamped notice when the effective mode matches the requested mode", () => {
    renderControl({ mode: "autonomous-delivery", effectiveMode: "autonomous-delivery" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a clamped notice when the deployment ceiling lowers the effective mode", () => {
    renderControl({ mode: "autonomous-delivery", effectiveMode: "governed-assist" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The deployment ceiling currently enforces Ask for approval for captures.",
    );
  });

  it("shows no clamped notice before the first hydrate/persist response lands", () => {
    renderControl({ mode: "autonomous-delivery", effectiveMode: null });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is axe-clean with a clamped notice and an error visible together", async () => {
    const { container } = renderControl({
      mode: "autonomous-delivery",
      effectiveMode: "supervised-coding",
      error: "persist",
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
