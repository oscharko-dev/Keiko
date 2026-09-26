import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ComposerShell, composerEnterSubmits } from "./ComposerShell";

function renderShell(onSubmit: () => void, value = "draft"): void {
  render(
    <main>
      <ComposerShell
        value={value}
        placeholder="Ask"
        ariaLabel="Message"
        onChange={() => undefined}
        onKeyDown={(event) => {
          if (composerEnterSubmits(event)) onSubmit();
        }}
        footer={<button type="button">Send</button>}
      />
    </main>,
  );
}

describe("ComposerShell", () => {
  it("submits on Enter and inserts a newline on Shift+Enter", () => {
    const onSubmit = vi.fn();
    renderShell(onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("never submits while an IME composition is being confirmed (uiux-fix F041 C206)", () => {
    const onSubmit = vi.fn();
    renderShell(onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the shared input stack and footer row and opts into shell chords", async () => {
    renderShell(() => undefined);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    expect(textarea).toHaveAttribute("data-shell-chord-bypass", "");
    expect(textarea.closest(".cmp-input-combobox")).not.toBeNull();
    expect(textarea.closest(".cmp-input-stack")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).closest(".cmp-footer-row")).not.toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
