// Accessibility tests for ConfirmDialog (issue #68).
// Covers: axe-clean modal, accessible name, focus-visible rings, and Escape/cancel
// closing via the native <dialog> cancel event.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ConfirmDialog } from "./ConfirmDialog";

// jsdom does not implement HTMLDialogElement.showModal / close — provide a minimal
// mock (same pattern as AddProjectDialog.test.tsx).
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
  vi.clearAllMocks();
});

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Remove project"
      description="This removes the project from the sidebar."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("renders an accessible dialog named by its title", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: /remove project/i }),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations with an error message", async () => {
    renderDialog({ errorMessage: "Could not remove the project." });
    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  it("confirm and cancel buttons have visible focus rings", () => {
    renderDialog({ confirmLabel: "Remove", cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass(
      "focus-visible:ring-2",
    );
    expect(screen.getByRole("button", { name: "Keep" })).toHaveClass(
      "focus-visible:ring-2",
    );
  });

  it("invokes onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ confirmLabel: "Remove" });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("invokes onCancel when the native dialog cancel (Escape) event fires", () => {
    const { onCancel } = renderDialog();
    const dialog = screen.getByRole("dialog");
    // Escape on a native <dialog> dispatches a cancel event; the component hooks it.
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
