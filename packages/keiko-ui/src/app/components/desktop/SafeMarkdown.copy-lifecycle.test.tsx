import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SafeMarkdown } from "./SafeMarkdown";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

const writeText = vi.fn<(text: string) => Promise<void>>();

function pendingClipboard(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  resetClientDiagnosticWriter();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("code copy feedback lifecycle", () => {
  it("releases its pending feedback timer when the code block unmounts", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const view = render(<SafeMarkdown source={"```js\nconst value = 7;\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    });
    expect(screen.getByText("Code copied")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    for (const phase of ["started", "settled"]) {
      expect(writer).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          stageReport: expect.objectContaining({ stage: "markdown copy feedback", phase }),
        }),
      );
    }
    expect(JSON.stringify(writer.mock.calls)).not.toContain("const value = 7;");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores %s after clipboard owner unmounts",
    async (outcome) => {
      const pending = pendingClipboard();
      writeText.mockReturnValue(pending.promise);
      const view = render(<SafeMarkdown source={"```js\nconst value = 7;\n```"} />);
      fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
      view.unmount();
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("clipboard unavailable"));
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("replaces earlier feedback with one timer for the latest successful copy", async () => {
    const view = render(<SafeMarkdown source={"```js\nconst value = 7;\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    });
    act(() => vi.advanceTimersByTime(1000));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Code copied")).toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains success feedback for its original duration while mounted", async () => {
    render(<SafeMarkdown source={"```js\nconst value = 7;\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    });
    act(() => vi.advanceTimersByTime(1499));
    expect(screen.getByText("Code copied")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Code copied")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code block" })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
