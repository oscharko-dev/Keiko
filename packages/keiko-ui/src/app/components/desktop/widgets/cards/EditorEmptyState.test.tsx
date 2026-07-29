import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

const { createProjectMock, pickMock, capability } = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  pickMock: vi.fn(),
  capability: { supported: true },
}));

vi.mock("../../../../../lib/api", () => ({
  createProject: createProjectMock,
}));
vi.mock("../../../../../lib/native-file-dialog", () => ({
  pickWithNativeDialog: pickMock,
}));
vi.mock("../../hooks/useNativeFileDialogCapability", () => ({
  useNativeFileDialogCapability: (): boolean => capability.supported,
}));

beforeEach(() => {
  capability.supported = true;
  createProjectMock.mockReset();
  createProjectMock.mockImplementation(async ({ path }: { readonly path: string }) => ({
    project: {
      path,
      name: "project",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
      workspaceAvailable: true,
    },
  }));
  pickMock.mockReset();
});

describe("EditorEmptyState", () => {
  it("connects the natively-picked directory before opening it as the workspace root", async () => {
    pickMock.mockResolvedValue({ kind: "picked", paths: ["/home/me/project"] });
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.click(screen.getByTestId("editor-empty-browse"));

    await waitFor(() => expect(onOpenRoot).toHaveBeenCalledWith("/home/me/project"));
    expect(createProjectMock).toHaveBeenCalledWith({ path: "/home/me/project" });
    expect(pickMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "open-directory" }));
  });

  it("connects a manually entered folder path before opening it", async () => {
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.change(screen.getByLabelText("Project folder path"), {
      target: { value: "  /abs/project  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(onOpenRoot).toHaveBeenCalledWith("/abs/project"));
    expect(createProjectMock).toHaveBeenCalledWith({ path: "/abs/project" });
  });

  it("does not bind a root when the native picker is cancelled", async () => {
    pickMock.mockResolvedValue({ kind: "cancelled" });
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.click(screen.getByTestId("editor-empty-browse"));

    await waitFor(() => expect(pickMock).toHaveBeenCalled());
    expect(onOpenRoot).not.toHaveBeenCalled();
  });

  it("surfaces a calm notice when the native picker errors", async () => {
    pickMock.mockResolvedValue({ kind: "error", message: "dialog crashed" });
    render(<EditorEmptyState onOpenRoot={vi.fn()} />);

    fireEvent.click(screen.getByTestId("editor-empty-browse"));

    expect(await screen.findByRole("status")).toHaveTextContent("dialog crashed");
  });

  it("keeps the editor unbound when project connection fails", async () => {
    createProjectMock.mockRejectedValueOnce(new Error("server detail must stay hidden"));
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.change(screen.getByLabelText("Project folder path"), {
      target: { value: "/abs/project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The project could not be connected. Check the folder and try again.",
    );
    expect(onOpenRoot).not.toHaveBeenCalled();
    expect(screen.queryByText(/server detail/u)).not.toBeInTheDocument();
  });

  it("keeps the editor unbound when registration returns unavailable membership", async () => {
    createProjectMock.mockResolvedValueOnce({
      project: {
        path: "/abs/project",
        name: "project",
        favorite: false,
        createdAt: 1,
        lastOpenedAt: 1,
        available: true,
        workspaceAvailable: false,
      },
    });
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.change(screen.getByLabelText("Project folder path"), {
      target: { value: "/abs/project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The saved workspace identity is no longer current.",
    );
    expect(onOpenRoot).not.toHaveBeenCalled();
  });

  it("disables the native picker button when the platform is unsupported", () => {
    capability.supported = false;
    render(<EditorEmptyState onOpenRoot={vi.fn()} />);

    expect(screen.getByTestId("editor-empty-browse")).toBeDisabled();
    // The manual path fallback stays usable.
    expect(screen.getByLabelText("Project folder path")).toBeEnabled();
  });
});
