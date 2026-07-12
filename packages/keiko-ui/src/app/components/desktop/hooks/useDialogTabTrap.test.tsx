import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useDialogTabTrap } from "./useDialogTabTrap";

function TestDialog({ disabled = false }: { readonly disabled?: boolean }): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogTabTrap(dialogRef);
  return (
    <div ref={dialogRef} tabIndex={-1} data-testid="dialog">
      <button type="button" disabled={disabled}>
        First
      </button>
      <button type="button" disabled={disabled}>
        Last
      </button>
    </div>
  );
}

function TestDialogWithFormControl(): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogTabTrap(dialogRef);
  return (
    <div ref={dialogRef} tabIndex={-1} data-testid="dialog">
      <label>
        Name
        <input type="text" />
      </label>
      <button type="button">Submit</button>
    </div>
  );
}

describe("useDialogTabTrap", () => {
  it("wraps Tab from the last focusable element back to the first", () => {
    render(<TestDialog />);
    const last = screen.getByRole("button", { name: "Last" });
    const first = screen.getByRole("button", { name: "First" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    render(<TestDialog />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it("wraps Shift+Tab to the last element when focus is still on the dialog container", () => {
    render(<TestDialog />);
    const dialog = screen.getByTestId("dialog");
    const last = screen.getByRole("button", { name: "Last" });

    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it("swallows Tab instead of leaking focus when every control is disabled", () => {
    render(<TestDialog disabled />);
    const dialog = screen.getByTestId("dialog");
    dialog.focus();

    const notCanceled = fireEvent.keyDown(document, { key: "Tab" });

    expect(notCanceled).toBe(false);
  });

  it("does not intercept non-Tab keys", () => {
    render(<TestDialog />);
    const first = screen.getByRole("button", { name: "First" });
    first.focus();

    const notCanceled = fireEvent.keyDown(document, { key: "Enter" });

    expect(notCanceled).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("treats non-button focusable controls (inputs) as part of the containment boundary", () => {
    render(<TestDialogWithFormControl />);
    const input = screen.getByRole("textbox", { name: "Name" });
    const submit = screen.getByRole("button", { name: "Submit" });

    submit.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });
});
