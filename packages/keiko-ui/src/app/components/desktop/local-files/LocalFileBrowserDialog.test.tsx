import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { LocalFileBrowserDialog } from "./LocalFileBrowserDialog";

const treeEntryBase = {
  sizeBytes: 0,
  modifiedAt: 1,
  extension: null,
  symlink: false,
  readable: true,
};

describe("LocalFileBrowserDialog", () => {
  it("closes through the Cancel button", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <LocalFileBrowserDialog
        mode="file"
        title="Choose file source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [],
        })}
        onApply={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await screen.findByRole("dialog", { name: /choose file source/i });
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes through Escape and overlay click", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { unmount } = render(
      <LocalFileBrowserDialog
        mode="folder"
        title="Choose folder source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [],
        })}
        onApply={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await screen.findByRole("dialog", { name: /choose folder source/i });
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    const onOverlayCancel = vi.fn();
    render(
      <LocalFileBrowserDialog
        mode="folder"
        title="Choose folder source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [],
        })}
        onApply={vi.fn()}
        onCancel={onOverlayCancel}
      />,
    );

    const overlayDialog = await screen.findByRole("dialog", { name: /choose folder source/i });
    fireEvent.click(overlayDialog.parentElement as HTMLElement);
    expect(onOverlayCancel).toHaveBeenCalledTimes(1);
  });

  it("opens a registered project root and applies the current folder in folder mode", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const fetchFilesTreeImpl = vi.fn(async (root: string, path = "") => ({
      root,
      path,
      truncated: false,
      entries: [],
    }));

    render(
      <LocalFileBrowserDialog
        mode="folder"
        title="Choose folder source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath=""
        fetchProjectsImpl={vi.fn().mockResolvedValue({
          projects: [
            { path: "/repo-a", name: "Repo A", available: true, availabilityReason: null },
            { path: "/repo-b", name: "Repo B", available: true, availabilityReason: null },
          ],
        })}
        fetchFilesTreeImpl={fetchFilesTreeImpl}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Repo B" }));
    await screen.findByText("/repo-b");
    await user.click(screen.getByRole("button", { name: /use selection/i }));

    expect(onApply).toHaveBeenCalledWith({
      rootPath: "/repo-b",
      folderPath: "/repo-b",
      files: [],
    });
  });

  it("opens a manually entered root path", async () => {
    const user = userEvent.setup();
    const fetchFilesTreeImpl = vi.fn(async (root: string, path = "") => ({
      root,
      path,
      truncated: false,
      entries: [],
    }));

    render(
      <LocalFileBrowserDialog
        mode="folder"
        title="Choose folder source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={fetchFilesTreeImpl}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const input = await screen.findByLabelText("Folder root");
    await user.clear(input);
    await user.type(input, "/other");
    await user.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(fetchFilesTreeImpl).toHaveBeenLastCalledWith("/other", "");
    });
  });

  it("returns an absolute file path from root plus relative file selection", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <LocalFileBrowserDialog
        mode="file"
        title="Choose file source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({
          projects: [{ path: "/repo", name: "Repo", available: true, availabilityReason: null }],
        })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [
            {
              ...treeEntryBase,
              name: "requirements.md",
              path: "docs/requirements.md",
              kind: "file",
              sizeBytes: 1200,
              extension: "md",
            },
          ],
        })}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /requirements\.md/i }));
    await user.click(screen.getByRole("button", { name: /use selection/i }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith({
        rootPath: "/repo",
        folderPath: "/repo",
        files: ["docs/requirements.md"],
      });
    });
  });

  it("opens folders and can select a file below the root", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const fetchFilesTreeImpl = vi.fn(async (_root: string, path = "") => ({
      root: "/repo",
      path,
      truncated: false,
      entries:
        path === ""
          ? [
              {
                ...treeEntryBase,
                name: "docs",
                path: "docs",
                kind: "directory" as const,
              },
            ]
          : [
              {
                ...treeEntryBase,
                name: "requirements.md",
                path: "docs/requirements.md",
                kind: "file" as const,
                sizeBytes: 1200,
                extension: "md",
              },
            ],
    }));

    render(
      <LocalFileBrowserDialog
        mode="file"
        title="Choose file source"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={fetchFilesTreeImpl}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "docs" }));
    expect(await screen.findByText("/repo/docs")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /requirements\.md/i }));
    await user.click(screen.getByRole("button", { name: /use selection/i }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith({
        rootPath: "/repo",
        folderPath: "/repo/docs",
        files: ["docs/requirements.md"],
      });
    });
  });

  it("supports selecting multiple files", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <LocalFileBrowserDialog
        mode="files"
        title="Choose file sources"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [
            { ...treeEntryBase, name: "a.md", path: "a.md", kind: "file", extension: "md" },
            { ...treeEntryBase, name: "b.md", path: "b.md", kind: "file", extension: "md" },
          ],
        })}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("checkbox", { name: /a\.md/i }));
    await user.click(screen.getByRole("checkbox", { name: /b\.md/i }));
    await user.click(screen.getByRole("button", { name: /use selection/i }));

    expect(onApply).toHaveBeenCalledWith({
      rootPath: "/repo",
      folderPath: "/repo",
      files: ["a.md", "b.md"],
    });
  });

  it("never offers a symlink entry for selection (the read path refuses to follow symlinks)", async () => {
    render(
      <LocalFileBrowserDialog
        mode="files"
        title="Choose file sources"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [
            { ...treeEntryBase, name: "real.md", path: "real.md", kind: "file", extension: "md" },
            // A symlink-kind entry AND a symlink-flagged regular file must both be non-selectable.
            { ...treeEntryBase, name: "link.md", path: "link.md", kind: "symlink", symlink: true },
            {
              ...treeEntryBase,
              name: "aliased.md",
              path: "aliased.md",
              kind: "file",
              symlink: true,
              extension: "md",
            },
          ],
        })}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByRole("checkbox", { name: /real\.md/i })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /link\.md/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /aliased\.md/i })).toBeDisabled();
  });

  it("renders an ApiError code and never a blank alert on a browse failure", async () => {
    const { ApiError } = await import("@/lib/api");
    render(
      <LocalFileBrowserDialog
        mode="folder"
        title="Choose folder"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
        fetchFilesTreeImpl={vi.fn().mockRejectedValue(new ApiError("FORBIDDEN", "", 403))}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    // The bare ApiError.message is empty here; the alert must still be non-blank and carry the code.
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(alert).toHaveTextContent(/FORBIDDEN/);
  });

  // GEN-UI-TEST-GAP-006 (#15) — opened from a real trigger button, closing the dialog (via Escape
  // or Cancel) must return focus to that trigger (WCAG 2.4.3), not strand it on document.body.
  function TriggeredDialog(props: {
    readonly onApply?: () => void;
    readonly onDidCancel?: () => void;
  }): ReactElement {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Choose source
        </button>
        {open ? (
          <LocalFileBrowserDialog
            mode="folder"
            title="Choose folder source"
            description="Browse a registered local project or enter an absolute folder root."
            initialRootPath="/repo"
            fetchProjectsImpl={vi.fn().mockResolvedValue({ projects: [] })}
            fetchFilesTreeImpl={vi.fn().mockResolvedValue({
              root: "/repo",
              path: "",
              truncated: false,
              entries: [],
            })}
            onApply={() => {
              props.onApply?.();
              setOpen(false);
            }}
            onCancel={() => {
              setOpen(false);
              props.onDidCancel?.();
            }}
          />
        ) : null}
      </>
    );
  }

  it("returns focus to the trigger button when closed via Escape", async () => {
    const user = userEvent.setup();
    render(<TriggeredDialog />);

    const trigger = screen.getByRole("button", { name: "Choose source" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /choose folder source/i });

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /choose folder source/i }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to the trigger button when closed via Cancel", async () => {
    const user = userEvent.setup();
    render(<TriggeredDialog />);

    const trigger = screen.getByRole("button", { name: "Choose source" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /choose folder source/i });

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /choose folder source/i }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // GEN-UI-TEST-GAP-006 (#16) — the browser dialog with a populated list is axe-clean.
  it("has no axe violations with a populated file list", async () => {
    const { container } = render(
      <LocalFileBrowserDialog
        mode="files"
        title="Choose file sources"
        description="Browse a registered local project or enter an absolute folder root."
        initialRootPath="/repo"
        fetchProjectsImpl={vi.fn().mockResolvedValue({
          projects: [{ path: "/repo", name: "Repo", available: true, availabilityReason: null }],
        })}
        fetchFilesTreeImpl={vi.fn().mockResolvedValue({
          root: "/repo",
          path: "",
          truncated: false,
          entries: [
            { ...treeEntryBase, name: "docs", path: "docs", kind: "directory" },
            { ...treeEntryBase, name: "a.md", path: "a.md", kind: "file", extension: "md" },
            { ...treeEntryBase, name: "b.md", path: "b.md", kind: "file", extension: "md" },
          ],
        })}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByRole("checkbox", { name: /a\.md/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
