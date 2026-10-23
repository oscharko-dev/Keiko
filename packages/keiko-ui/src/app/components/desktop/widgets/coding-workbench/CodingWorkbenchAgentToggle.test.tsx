import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchAgent } from "@oscharko-dev/keiko-contracts";
import {
  I18nProvider,
  I18N_STORAGE_KEY,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";
import { CodingWorkbenchAgentToggle } from "./CodingWorkbenchAgentToggle";

// The toggle is mounted on its own, outside any page landmark; the page-composition "region" rule
// says nothing about the control itself.
const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

interface ToggleOverrides {
  readonly agents?: readonly CodingWorkbenchAgent[];
  readonly value?: CodingWorkbenchAgent;
  readonly disabled?: boolean;
}

function renderToggle(
  overrides: ToggleOverrides = {},
  onChange: (agent: CodingWorkbenchAgent) => void = vi.fn(),
): (agent: CodingWorkbenchAgent) => void {
  render(
    <I18nProvider>
      <CodingWorkbenchAgentToggle
        agents={overrides.agents ?? ["build", "plan"]}
        value={overrides.value ?? "build"}
        disabled={overrides.disabled ?? false}
        onChange={onChange}
      />
    </I18nProvider>,
  );
  return onChange;
}

describe("Coding Workbench agent toggle", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(I18N_STORAGE_KEY);
    resetLoadedMessageCatalogs();
  });

  it("renders nothing while the server offers only the default agent", () => {
    renderToggle({ agents: ["build"] });
    expect(screen.queryByRole("group", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
  });

  it("shows a labelled Build and Plan choice with the active agent pressed", () => {
    renderToggle({ value: "build" });
    const group = screen.getByRole("group", { name: "Agent" });
    expect(group).toContainElement(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("button", { name: "Build" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "false");
  });

  it("describes what each agent does", () => {
    renderToggle();
    expect(screen.getByRole("button", { name: "Build" })).toHaveAccessibleDescription(
      "The agent changes files and runs commands within the selected mode.",
    );
    expect(screen.getByRole("button", { name: "Plan" })).toHaveAccessibleDescription(
      "The agent analyzes and writes a plan without changing workspace files.",
    );
  });

  it("selects the other agent by click", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ value: "build" });
    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("plan");
  });

  it("is operable from the keyboard with Tab, Enter and Space", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ value: "build" });
    await user.tab();
    expect(screen.getByRole("button", { name: "Build" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Plan" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("plan");
  });

  it("does not report a selection of the agent that is already active", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ value: "plan" });
    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is disabled as a whole while a turn is running", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ disabled: true, value: "plan" });
    for (const name of ["Build", "Plan"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    await user.click(screen.getByRole("button", { name: "Build" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no accessibility violations in either state", async () => {
    renderToggle({ value: "plan" });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    cleanup();
    renderToggle({ disabled: true });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("speaks German with the owner-specified labels", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    renderToggle({ value: "plan" });
    expect(screen.getByRole("group", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bauen" })).toHaveAccessibleDescription(
      "Der Agent ändert Dateien und führt Befehle im gewählten Modus aus.",
    );
    expect(screen.getByRole("button", { name: "Planen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Planen" })).toHaveAccessibleDescription(
      "Der Agent analysiert und erstellt einen Plan, ohne Arbeitsbereichsdateien zu ändern.",
    );
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
