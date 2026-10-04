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
  it("reveals a deep cited line with a bounded initial viewport and accessible preceding lines", async () => {
    const content = Array.from(
      { length: 60_000 },
      (_, index) => `source line ${String(index + 1)}`,
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
    expect(region).not.toHaveTextContent("source line 1source");
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
