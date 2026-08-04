import { render, screen, waitFor } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreModalTriggerFocus, useModalInteractionLock } from "./useModalInteractionLock";

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

afterEach(() => {
  vi.restoreAllMocks();
});

function runNextFrame(frames: FrameRequestCallback[]): void {
  const callback = frames.shift();
  if (callback === undefined) throw new Error("focus restoration did not schedule a frame");
  callback(0);
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

  it("does not restore focus to a disconnected trigger", () => {
    const trigger = document.createElement("button");
    const focus = vi.spyOn(trigger, "focus");
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    restoreModalTriggerFocus(trigger);
    runNextFrame(frames);

    expect(focus).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("stops retrying when the focus-restoration budget is exhausted", () => {
    const inertParent = document.createElement("div");
    const trigger = document.createElement("button");
    inertParent.setAttribute("inert", "");
    inertParent.append(trigger);
    document.body.append(inertParent);
    const focus = vi.spyOn(trigger, "focus");
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    restoreModalTriggerFocus(trigger, 2);
    runNextFrame(frames);
    runNextFrame(frames);

    expect(focus).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
    inertParent.remove();
  });
});
