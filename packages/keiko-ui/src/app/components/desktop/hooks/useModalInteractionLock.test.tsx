import { render, screen, waitFor } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "@/lib/client-diagnostics";
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dialog action" })).toHaveFocus(),
    );
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

  it.each(["button", "fieldset"] as const)(
    "waits for a temporarily disabled %s before returning focus",
    (disabledOwner) => {
      const parent = document.createElement("fieldset");
      const trigger = document.createElement("button");
      parent.append(trigger);
      document.body.append(parent);
      const disabled = disabledOwner === "button" ? trigger : parent;
      disabled.disabled = true;
      const focus = vi.spyOn(trigger, "focus");
      const reports = vi.spyOn(diagnostics, "reportClientDiagnostic").mockImplementation(() => {});
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });

      try {
        restoreModalTriggerFocus(trigger);
        runNextFrame(frames);
        expect(focus).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);

        disabled.disabled = false;
        runNextFrame(frames);
        expect(trigger).toHaveFocus();
        expect(frames).toHaveLength(0);
        const started = reports.mock.calls[0]?.[1];
        expect(started?.stageReport).toEqual({
          stage: "modal focus restoration",
          phase: "started",
          ordinal: 1,
        });
        expect(reports.mock.calls[1]?.[1]).toEqual({
          correlationId: started?.correlationId,
          stageReport: {
            stage: "modal focus restoration",
            phase: "settled",
            ordinal: 1,
            durationMs: expect.any(Number),
            navigationOutcome: "applied",
          },
        });
        expect(reports).toHaveBeenCalledTimes(2);
      } finally {
        parent.remove();
      }
    },
  );

  it("keeps a person's new focus while the original trigger is unavailable", () => {
    const view = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.setAttribute("disabled", "");
    const other = document.createElement("button");
    document.body.append(other);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const reports = vi.spyOn(diagnostics, "reportClientDiagnostic").mockImplementation(() => {});
    try {
      restoreModalTriggerFocus(trigger);
      runNextFrame(frames);
      other.focus();
      trigger.removeAttribute("disabled");
      runNextFrame(frames);

      expect(other).toHaveFocus();
      expect(frames).toHaveLength(0);
      expect(reports.mock.calls.at(-1)?.[1]?.stageReport).toMatchObject({
        phase: "settled",
        navigationOutcome: "cancelled",
      });
      expect(reports).toHaveBeenCalledTimes(2);
    } finally {
      other.remove();
      view.unmount();
    }
  });

  it("allows the closing dialog to unmount before restoring its trigger", () => {
    const view = render(<Harness open={false} />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.setAttribute("disabled", "");
    const closing = document.createElement("button");
    document.body.append(closing);
    closing.focus();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    restoreModalTriggerFocus(trigger);
    runNextFrame(frames);
    expect(closing).toHaveFocus();
    closing.remove();
    trigger.removeAttribute("disabled");
    runNextFrame(frames);
    expect(trigger).toHaveFocus();
    expect(frames).toHaveLength(0);
    view.unmount();
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
