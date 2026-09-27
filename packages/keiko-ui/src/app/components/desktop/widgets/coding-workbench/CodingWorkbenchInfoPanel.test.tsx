import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

import { CodingWorkbenchInfoPanel } from "./CodingWorkbenchInfoPanel";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

describe("Coding Workbench information popover", () => {
  // #3634: Escape removed the popover together with its focused element, so keyboard focus fell to
  // the page. It returns to the trigger, like the codebase's other popovers (GEN-UI-FOCUS-011).
  it("returns focus to the Information trigger when Escape closes the popover", () => {
    render(<CodingWorkbenchInfoPanel facts={[]} />);
    const trigger = screen.getByRole("button", {
      name: translateCodingWorkbench("en", "codingWorkbench.info.open"),
    });
    fireEvent.click(trigger);
    const summary = screen.getByText(
      translateCodingWorkbench("en", "codingWorkbench.info.details"),
    );
    summary.focus();
    expect(summary).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on a pointer press outside without moving focus to the trigger", () => {
    render(
      <>
        <button type="button">Outside</button>
        <CodingWorkbenchInfoPanel facts={[]} />
      </>,
    );
    const trigger = screen.getByRole("button", {
      name: translateCodingWorkbench("en", "codingWorkbench.info.open"),
    });
    fireEvent.click(trigger);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.pointerDown(outside);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
});
