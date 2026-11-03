import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodingTaskForkNotice } from "./CodingTaskForkNotice";

// S03 (#3904): the notice says what the next message will do, in the person's own terms, and lets
// them take the request back. It names the task by its title and shows nothing without a fork.
describe("CodingTaskForkNotice", () => {
  it("renders nothing without a fork", () => {
    const { container } = render(<CodingTaskForkNotice fork={null} onCancel={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("says the next message forks the task as it ended", () => {
    render(
      <CodingTaskForkNotice
        fork={{ taskId: "task-7", title: "Repair the parser" }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Repair the parser");
  });

  it("says the next message forks the task before the chosen message", () => {
    const { rerender } = render(
      <CodingTaskForkNotice
        fork={{ taskId: "task-7", title: "Repair the parser" }}
        onCancel={vi.fn()}
      />,
    );
    const ended = screen.getByRole("status").textContent;

    rerender(
      <CodingTaskForkNotice
        fork={{ taskId: "task-7", title: "Repair the parser", beforeMessageId: "m-3" }}
        onCancel={vi.fn()}
      />,
    );

    const before = screen.getByRole("status").textContent;
    expect(before).toContain("Repair the parser");
    expect(before).not.toBe(ended);
  });

  // #3903 AC4: a continuation names the workspace the new task starts in.
  it("says the next message continues the task in the workspace it names", () => {
    render(
      <CodingTaskForkNotice
        fork={{
          taskId: "task-7",
          title: "Repair the parser",
          targetWorkspace: { workspaceId: "workspace-2", name: "feature-x" },
        }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Your next message starts a new task in the workspace “feature-x”, continued from “Repair the parser”.",
    );
  });

  it("lets the person take the request back", () => {
    const onCancel = vi.fn();
    render(
      <CodingTaskForkNotice
        fork={{ taskId: "task-7", title: "Repair the parser" }}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel fork" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  // #3904 AC4: an imported task continues only as a new task, so there is nothing to cancel.
  it("says an imported task continues as a new task and offers no cancel", () => {
    render(
      <CodingTaskForkNotice
        fork={{ taskId: "task-7", title: "Repair the parser", implicit: true }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "“Repair the parser” was imported from a file. Your next message continues it as a new task",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
