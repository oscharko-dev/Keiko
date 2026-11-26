import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnswerCopyButton, type AnswerCopyButtonLabels } from "./AnswerCopyButton";

const writeText = vi.fn<(text: string) => Promise<void>>();
const labels: AnswerCopyButtonLabels = {
  copy: "Copy answer",
  copied: "Copied",
  copiedStatus: "Answer copied",
  failedStatus: "Copy failed",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  writeText.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function click(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
  });
}

describe("AnswerCopyButton", () => {
  it("resets the copied state after its feedback time", async () => {
    writeText.mockResolvedValue(undefined);
    render(<AnswerCopyButton text="hello" labels={labels} />);
    await click();
    expect(screen.getByText("Answer copied")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    expect(screen.queryByText("Answer copied")).not.toBeInTheDocument();
  });

  it("resets the failed state after its feedback time as well", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AnswerCopyButton text="hello" labels={labels} />);
    await click();
    const button = screen.getByRole("button", { name: "Copy answer" });
    expect(screen.getByText("Copy failed")).toBeInTheDocument();
    expect(button).toHaveAttribute("data-failed", "true");
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("data-failed", "false");
  });

  it("renders nothing for a cut or failed-to-read prefix", () => {
    render(<AnswerCopyButton text="prefix" labels={labels} partial />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
