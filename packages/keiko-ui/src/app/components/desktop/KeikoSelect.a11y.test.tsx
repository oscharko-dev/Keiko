// GEN-UI-A11Y-008 / test-plan #22 — a11y smoke for KeikoSelect. jest-axe runs the
// WCAG 2.2 AA rule set against both the collapsed trigger and the open listbox, and
// we assert the combobox/listbox/option roles + accessible name + aria-expanded
// toggle that assistive tech relies on to operate the control.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import KeikoSelect from "./KeikoSelect";

// The "region" landmark rule flags page content that is not inside a landmark.
// It is a page-composition concern, not a KeikoSelect defect (the control is
// mounted in isolation here and the listbox portals to document.body), so it is
// disabled for this component-scoped smoke test.
const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

const sections = [
  {
    label: "Strategy",
    options: [
      { value: "model", label: "Model only" },
      { value: "files", label: "Live Files context" },
    ],
  },
] as const;

describe("KeikoSelect accessibility", () => {
  it("has no axe violations while closed and exposes a named combobox with aria-expanded=false", async () => {
    const { container } = render(
      <KeikoSelect
        ariaLabel="Context strategy"
        menuTitle="Context strategy"
        onValueChange={vi.fn()}
        sections={sections}
        value="model"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Context strategy" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("has no axe violations while open and exposes listbox + option roles with an accessible name", async () => {
    render(
      <KeikoSelect
        ariaLabel="Context strategy"
        menuTitle="Context strategy"
        onValueChange={vi.fn()}
        sections={sections}
        value="model"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Context strategy" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    // aria-expanded flips to true once the popup is open.
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox", { name: "Context strategy" });
    expect(listbox).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.getByRole("option", { name: "Model only" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Live Files context" })).toBeInTheDocument();

    // The listbox portals to document.body; axe over the whole document exercises
    // both the trigger and the popup for role/name/ownership violations.
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });

  // #3873 live review: the Coding Workbench listboxes showed every option as a nameless "option" in
  // the accessibility tree, although each displayed its text. The visible text sits two spans deep
  // inside the option, so an accessibility consumer that does not derive a name from descendant
  // content announced nothing. Each option now carries its whole visible text as its own name.
  it("names every option by its own visible text, description and badge included", async () => {
    render(
      <KeikoSelect
        ariaLabel="Coding repository"
        onValueChange={vi.fn()}
        sections={[
          {
            options: [
              { value: "plain", label: "gemma-4-31b-it" },
              { value: "described", label: "Model only", description: "No live files" },
              { value: "badged", label: "archive", badge: "unavailable", disabled: true },
            ],
          },
        ]}
        value="plain"
      />,
    );

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Coding repository" }), {
      key: "ArrowDown",
    });

    for (const parts of [
      ["gemma-4-31b-it"],
      ["Model only", "No live files"],
      ["archive", "unavailable"],
    ] as const) {
      const option = screen.getByRole("option", { name: parts.join(", ") });
      expect(option).toHaveAttribute("aria-label", parts.join(", "));
      for (const part of parts) expect(option).toHaveTextContent(part);
    }
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
