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
});
