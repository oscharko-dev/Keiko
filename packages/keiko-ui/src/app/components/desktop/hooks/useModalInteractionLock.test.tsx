import { render, screen, waitFor } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useModalInteractionLock } from "./useModalInteractionLock";

function ModalLock(): ReactNode {
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  useModalInteractionLock({ initialFocusRef });
  return <button ref={initialFocusRef}>Dialog action</button>;
}

function Harness({ open }: { readonly open: boolean }): ReactNode {
  return (
    <>
      <div data-testid="stage">
        <button>Open dialog</button>
      </div>
      {open ? <ModalLock /> : null}
    </>
  );
}

describe("useModalInteractionLock", () => {
  it("restores focus only after the trigger is no longer inert", async () => {
    const view = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    const stage = screen.getByTestId("stage");
    trigger.focus();

    view.rerender(<Harness open />);
    expect(screen.getByRole("button", { name: "Dialog action" })).toHaveFocus();
    stage.setAttribute("inert", "");

    view.rerender(<Harness open={false} />);
    expect(trigger).not.toHaveFocus();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    expect(trigger).not.toHaveFocus();
    stage.removeAttribute("inert");

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
