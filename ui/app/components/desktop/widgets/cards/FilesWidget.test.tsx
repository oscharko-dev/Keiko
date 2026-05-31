import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFilesPreview, fetchFilesTree } from "../../../../../lib/api";
import { FilePreview } from "./FilePreview";
import { FilesWidget } from "./FilesWidget";

vi.mock("../../../../../lib/api", () => ({
  fetchFilesPreview: vi.fn(),
  fetchFilesTree: vi.fn(),
}));

const treeEntryBase = {
  sizeBytes: 0,
  modifiedAt: 1,
  extension: null,
  symlink: false,
  readable: true,
};

describe("FilesWidget", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the root tree and opens a text preview on file click", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          sizeBytes: 18,
          extension: "json",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo space",
      path: "package.json",
      name: "package.json",
      sizeBytes: 18,
      modifiedAt: 1,
      extension: "json",
      mime: "application/json",
      symlink: false,
      kind: "text",
      content: "{\"name\":\"keiko\"}\n",
      truncated: false,
      maxBytes: 1_000_000,
    });

    render(<FilesWidget root="/repo space" />);

    expect(await screen.findByText("package.json")).toBeInTheDocument();
    expect(fetchFilesTree).toHaveBeenCalledWith("/repo space", "");

    await userEvent.click(screen.getByRole("button", { name: /package\.json/i }));

    await waitFor(() => expect(fetchFilesPreview).toHaveBeenCalledWith("/repo space", "package.json"));
    expect(await screen.findByText("\"keiko\"")).toBeInTheDocument();
  });

  it("renders tree loading errors", async () => {
    vi.mocked(fetchFilesTree).mockRejectedValueOnce(new Error("access denied"));

    render(<FilesWidget root="/repo" />);

    expect(await screen.findByText("access denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("FilePreview", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders binary preview metadata instead of code", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "archive.bin",
      name: "archive.bin",
      sizeBytes: 6,
      modifiedAt: 1,
      extension: "bin",
      mime: "text/plain",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="archive.bin" onClose={() => undefined} />);

    expect(await screen.findByText("No safe text or image preview is available for this file type."))
      .toBeInTheDocument();
    expect(screen.getAllByText("archive.bin").length).toBeGreaterThan(0);
  });
});
