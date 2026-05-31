// Accessibility tests for ComposerModeSelector (issue #68).
// Covers: axe-clean radiogroup, roving-tabindex arrow navigation (ARIA APG,
// WCAG 2.1.1 — no keyboard trap).

import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ComposerModeSelector } from "./ComposerModeSelector";
import type { ComposerMode } from "./ChatComposer";

// Stateful harness so arrow-key navigation drives focus to the next pill, exactly
// as the parent composer would re-render the controlled `mode` prop.
function Harness({ initialMode = null }: { initialMode?: ComposerMode | null }) {
  const [mode, setMode] = useState<ComposerMode | null>(initialMode);
  return <ComposerModeSelector mode={mode} disabled={false} onChange={setMode} />;
}

describe("ComposerModeSelector", () => {
  it("renders a radiogroup with one radio per mode", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: /workflow mode/i })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("has no axe violations (none selected)", async () => {
    const { container } = render(<Harness />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations (a mode selected)", async () => {
    const { container } = render(<Harness initialMode="explain-plan" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ── Roving tabindex (ARIA APG radiogroup) ──────────────────────────────────

  it("only the first radio is in the tab order when none is selected", () => {
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveAttribute("tabindex", "0");
    expect(radios[1]).toHaveAttribute("tabindex", "-1");
    expect(radios[2]).toHaveAttribute("tabindex", "-1");
    expect(radios[3]).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight advances selection and moves focus (no keyboard trap)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    radios[0]!.focus();

    await user.keyboard("{ArrowRight}");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveFocus();
  });

  it("ArrowLeft retreats selection and wraps to the last radio", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    radios[0]!.focus();

    await user.keyboard("{ArrowLeft}");
    expect(radios[3]).toHaveAttribute("aria-checked", "true");
    expect(radios[3]).toHaveFocus();
  });

  it("ArrowRight wraps from the last radio back to the first", async () => {
    const user = userEvent.setup();
    render(<Harness initialMode="verify" />);
    const radios = screen.getAllByRole("radio");
    radios[3]!.focus();

    await user.keyboard("{ArrowRight}");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveFocus();
  });

  it("clicking a pill selects it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComposerModeSelector mode={null} disabled={false} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /investigate bug/i }));
    expect(onChange).toHaveBeenCalledWith("investigate-bug");
  });
});
