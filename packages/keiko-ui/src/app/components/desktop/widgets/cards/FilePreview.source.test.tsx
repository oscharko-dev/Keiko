import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchFilesPreview } from "@/lib/api";
import type { FilesPreviewResponse } from "@/lib/types";
import { FilePreview } from "./FilePreview";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchFilesPreview: vi.fn(),
}));

function textPreview(
  root = "/repo",
  path = "manual.html",
  content = "Ölwechsel 425 Stunden",
): Extract<FilesPreviewResponse, { readonly kind: "text" }> {
  return {
    root,
    path,
    name: path,
    sizeBytes: content.length,
    modifiedAt: 1,
    extension: "html",
    mime: "text/html",
    symlink: false,
    kind: "text",
    content,
    truncated: false,
    maxBytes: 2_097_152,
    canEdit: false,
  };
}

beforeEach(() => {
  vi.mocked(fetchFilesPreview).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("read-only cited source preview", () => {
  it("keeps expanded source lines when a manual refresh returns identical content", async () => {
    const content = Array.from(
      { length: 1_200 },
      (_, index) => `row ${index + 1} ${"detail ".repeat(30)}`,
    ).join("\n");
    vi.mocked(fetchFilesPreview).mockImplementation(async () =>
      textPreview("/repo", "manual.html", content),
    );
    render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
    const region = await screen.findByRole("region", { name: "File preview: manual.html" });
    fireEvent.click(screen.getByRole("button", { name: "Show 500 more lines" }));
    expect(region.querySelectorAll(".fpv-line")).toHaveLength(1_000);
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(fetchFilesPreview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Reloaded")).toBeInTheDocument());
    expect(region.querySelectorAll(".fpv-line")).toHaveLength(1_000);
    expect(region).toHaveTextContent("row 1000");
  });

  it("does not allocate a token array for every short line in a two MiB source", async () => {
    const content = "x\n".repeat(1_048_576);
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/repo", "manual.html", content),
    );
    const mapped = vi.spyOn(Array.prototype, "map");
    try {
      render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
      const region = await screen.findByRole("region", { name: "File preview: manual.html" });
      expect(region.querySelectorAll(".fpv-line")).toHaveLength(500);
      expect(mapped.mock.contexts.some((rows) => Array.isArray(rows) && rows.length > 500)).toBe(
        false,
      );
    } finally {
      mapped.mockRestore();
    }
  });

  it("reveals a deep cited line with a bounded initial viewport and accessible preceding lines", async () => {
    const content = Array.from({ length: 60_000 }, (_, index) =>
      index === 0 ? "UNIQUE_EARLY_SOURCE_SENTINEL" : `source line ${String(index + 1)}`,
    ).join("\n");
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/repo", "manual.html", content),
    );
    render(
      <FilePreview
        root="/repo"
        path="manual.html"
        revealLineStart={58_000}
        onClose={() => undefined}
      />,
    );
    const region = await screen.findByRole("region", { name: "File preview: manual.html" });
    await waitFor(() => expect(region).toHaveTextContent("source line 58000"));
    expect(region.querySelectorAll(".fpv-line").length).toBeLessThanOrEqual(500);
    expect(region).not.toHaveTextContent("UNIQUE_EARLY_SOURCE_SENTINEL");
    expect(region).toHaveTextContent("source line 57995");
    fireEvent.click(screen.getByRole("button", { name: "Show 500 previous lines" }));
    expect(region.querySelectorAll(".fpv-line").length).toBeLessThanOrEqual(1000);
    expect(region).toHaveTextContent("source line 57500");
  });

  it.each([false, true])(
    "honors the server's independent editing capability (%s)",
    async (canEdit) => {
      const open = vi.fn();
      vi.mocked(fetchFilesPreview).mockResolvedValueOnce({ ...textPreview(), canEdit });
      render(
        <FilePreview
          root="/repo"
          path="manual.html"
          onClose={() => undefined}
          onOpenInEditor={open}
        />,
      );
      await screen.findByRole("region", { name: "File preview: manual.html" });
      const button = screen.queryByRole("button", { name: "Open in editor" });
      if (canEdit) {
        expect(button).not.toBeNull();
        if (button === null) throw new TypeError("Missing editable preview action.");
        fireEvent.click(button);
        expect(open).toHaveBeenCalledWith("/repo", "manual.html");
      } else {
        expect(button).toBeNull();
        expect(screen.getByText(/Read-only source preview/)).toBeInTheDocument();
      }
    },
  );

  it("hides the old source immediately when the selected root changes", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/repo", "manual.html", "old source"),
    );
    const view = render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "File preview: manual.html" })).toHaveTextContent(
        "old source",
      ),
    );
    vi.mocked(fetchFilesPreview).mockReturnValueOnce(new Promise(() => undefined));
    view.rerender(<FilePreview root="/other" path="manual.html" onClose={() => undefined} />);
    expect(document.body).not.toHaveTextContent("old source");
  });

  it("rejects a mismatched response instead of showing another source", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/other", "manual.html", "wrong source"),
    );
    render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("wrong source");
  });

  it("withdraws retained content when a refresh is denied", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/repo", "manual.html", "old source"),
    );
    const view = render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "File preview: manual.html" })).toHaveTextContent(
        "old source",
      ),
    );
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new ApiError("DENIED", "Denied.", 403));
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("old source");
    view.unmount();
  });
});
