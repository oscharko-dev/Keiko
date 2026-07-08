import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

const { pickMock, capability } = vi.hoisted(() => ({
  pickMock: vi.fn(),
  capability: { supported: true },
}));

vi.mock("../../../../../lib/native-file-dialog", () => ({
  pickWithNativeDialog: pickMock,
}));
vi.mock("../../hooks/useNativeFileDialogCapability", () => ({
  useNativeFileDialogCapability: (): boolean => capability.supported,
}));

beforeEach(() => {
  capability.supported = true;
  pickMock.mockReset();
});

describe("EditorEmptyState", () => {
  it("opens the natively-picked directory as the workspace root", async () => {
    pickMock.mockResolvedValue({ kind: "picked", paths: ["/home/me/project"] });
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.click(screen.getByTestId("editor-empty-browse"));

    await waitFor(() => expect(onOpenRoot).toHaveBeenCalledWith("/home/me/project"));
    expect(pickMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "open-directory" }));
  });

  it("opens a manually entered folder path (trimmed)", () => {
    const onOpenRoot = vi.fn();
    render(<EditorEmptyState onOpenRoot={onOpenRoot} />);

    fireEvent.change(screen.getByLabelText("Project folder path"), {
      target: { value: "  /abs/project  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onOpenRoot).toHaveBeenCalledWith("/abs/project");
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

  it("disables the native picker button when the platform is unsupported", () => {
    capability.supported = false;
    render(<EditorEmptyState onOpenRoot={vi.fn()} />);

    expect(screen.getByTestId("editor-empty-browse")).toBeDisabled();
    // The manual path fallback stays usable.
    expect(screen.getByLabelText("Project folder path")).toBeEnabled();
  });
});
