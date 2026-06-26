import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { RuntimeHubWidget } from "./RuntimeHubWidget";

function handlers() {
  return {
    onProjectPathChange: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenCommands: vi.fn(),
    onOpenContainers: vi.fn(),
    onOpenGovernedGit: vi.fn(),
    onOpenPullRequest: vi.fn(),
    onOpenMerge: vi.fn(),
  };
}

describe("RuntimeHubWidget", () => {
  it("opens the existing runtime, Git, and command surfaces for the selected project", async () => {
    const h = handlers();
    render(<RuntimeHubWidget projectPath="/repo" {...h} />);

    await userEvent.click(screen.getByRole("button", { name: "Files & Git diff" }));
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await userEvent.click(screen.getByRole("button", { name: "Containers" }));
    await userEvent.click(screen.getByRole("button", { name: "Governed Git" }));
    await userEvent.click(screen.getByRole("button", { name: "Pull Request" }));
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(h.onOpenFiles).toHaveBeenCalledWith("/repo");
    expect(h.onOpenCommands).toHaveBeenCalledWith("/repo");
    expect(h.onOpenContainers).toHaveBeenCalledWith("/repo");
    expect(h.onOpenGovernedGit).toHaveBeenCalledWith("/repo");
    expect(h.onOpenPullRequest).toHaveBeenCalledWith("/repo");
    expect(h.onOpenMerge).toHaveBeenCalledWith("/repo");
  });

  it("keeps write-capable workflows disabled until a project path is present", async () => {
    const h = handlers();
    render(<RuntimeHubWidget {...h} />);

    expect(screen.getByRole("button", { name: "Tasks" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Governed Git" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull Request" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Files & Git diff" }));
    await userEvent.click(screen.getByRole("button", { name: "Containers" }));

    expect(h.onOpenFiles).toHaveBeenCalledWith(undefined);
    expect(h.onOpenContainers).toHaveBeenCalledWith(undefined);
  });

  it("persists a typed project path and exposes audit metadata boundaries accessibly", async () => {
    const h = handlers();
    const { container } = render(<RuntimeHubWidget {...h} />);

    const input = screen.getByLabelText("Project path");
    await userEvent.type(input, "/repo");
    await userEvent.tab();

    expect(h.onProjectPathChange).toHaveBeenCalledWith("/repo");
    expect(screen.getByLabelText("Runtime audit metadata")).toHaveTextContent(
      "runId / taskId / exit status",
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("syncs the editable project path when the window configuration changes", () => {
    const h = handlers();
    const view = render(<RuntimeHubWidget projectPath="/repo" {...h} />);

    expect(screen.getByLabelText("Project path")).toHaveValue("/repo");

    view.rerender(<RuntimeHubWidget projectPath="/repo-next" {...h} />);

    expect(screen.getByLabelText("Project path")).toHaveValue("/repo-next");
  });
});
