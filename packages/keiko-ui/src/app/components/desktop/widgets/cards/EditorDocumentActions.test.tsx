import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { EditorDocumentActions } from "./EditorDocumentActions";

describe("secondary document actions", () => {
  it("supports keyboard access, Escape and outside dismissal without invoking an action", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const view = render(
      <EditorDocumentActions
        label="More file actions"
        actions={[{ label: "File history", run }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More file actions" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "File history" })).toHaveFocus();
    expect(await axe(view.container)).toHaveNoViolations();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("button", { name: "File history" })).not.toBeVisible();
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "File history" })).toHaveFocus();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("button", { name: "File history" })).not.toBeVisible();
    expect(trigger).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
  });
});
