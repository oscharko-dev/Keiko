import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManagedTaskWorkspaceUnavailable } from "./ManagedTaskWorkspaceUnavailable";

describe("ManagedTaskWorkspaceUnavailable", () => {
  it("shows retry outside the checking state and invokes it", () => {
    const onRetry = vi.fn();
    render(<ManagedTaskWorkspaceUnavailable access="unavailable" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("hides retry while access is being checked", () => {
    render(<ManagedTaskWorkspaceUnavailable access="checking" onRetry={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.getByText("Connecting to the task workspace…")).toBeInTheDocument();
  });

  it("names an unpaired browser session and does not offer an ineffective retry", () => {
    render(<ManagedTaskWorkspaceUnavailable access="unpaired" onRetry={vi.fn()} />);

    expect(screen.getByRole("note")).toHaveAccessibleName("Browser session not paired");
    expect(
      screen.getByText(
        "The selected project is available, but this browser has no launcher permission for private task-workspace content. Restart Keiko through its launcher.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
