import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyWorkspaceBlob, emptyWorkspaceBlobPath } from "./EmptyWorkspaceBlob";

describe("EmptyWorkspaceBlob", () => {
  it("renders a real button with the masked empty-workspace copy", () => {
    render(<EmptyWorkspaceBlob onNewWindow={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Open a new window" });
    expect(button).toHaveClass("empty-workspace-blob");
    expect(screen.getByText("Empty workspace")).toBeInTheDocument();
    expect(screen.getByText("Open a window to start working")).toBeInTheDocument();

    const mask = button.querySelector("mask");
    expect(mask).not.toBeNull();
    expect(button.querySelector(".empty-workspace-blob__fill")?.getAttribute("mask")).toMatch(
      /^url\(#ewb-/u,
    );
  });

  it("uses the 25 percent larger logo knockout scale", () => {
    render(<EmptyWorkspaceBlob onNewWindow={vi.fn()} />);

    expect(
      screen
        .getByRole("button", { name: "Open a new window" })
        .querySelector('g[transform="translate(107,64) scale(0.080625)"]'),
    ).not.toBeNull();
  });

  it("activates the new-window callback from the whole blob", () => {
    const onNewWindow = vi.fn();
    render(<EmptyWorkspaceBlob onNewWindow={onNewWindow} />);

    fireEvent.click(screen.getByRole("button", { name: "Open a new window" }));

    expect(onNewWindow).toHaveBeenCalledTimes(1);
  });

  it("generates an organic closed SVG path", () => {
    const path = emptyWorkspaceBlobPath(0.7);

    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("C");
    expect(path.endsWith("Z")).toBe(true);
  });
});
