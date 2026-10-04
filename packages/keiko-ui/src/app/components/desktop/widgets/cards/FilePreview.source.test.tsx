import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchFilesPreview } from "@/lib/api";
import type { FilesPreviewResponse } from "@/lib/types";
import { resetFilesNavigationEvidenceForTests } from "@/lib/files-navigation-evidence";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
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
  resetFilesNavigationEvidenceForTests();
});
afterEach(() => {
  vi.clearAllMocks();
  resetClientDiagnosticWriter();
});

describe("read-only cited source preview", () => {
  it("keeps the measured size refusal ahead of a generic searchable-document hint", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      ...textPreview("/repo", "manual.pdf"),
      kind: "binary",
      extension: "pdf",
      mime: "application/pdf",
      sizeBytes: 12 * 1024 * 1024,
      reason: "too_large",
      maxBytes: 2 * 1024 * 1024,
    });
    render(<FilePreview root="/repo" path="manual.pdf" onClose={() => undefined} />);
    expect(
      await screen.findByText("Preview disabled because this file exceeds 2.00 MB."),
    ).toBeVisible();
    expect(screen.queryByText(/is searchable/)).toBeNull();
  });

  it("keeps the revealed source region accessible with its range announcement", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(
      textPreview("/repo", "manual.html", "first\nsecond\nthird\nfourth"),
    );
    const { container } = render(
      <FilePreview
        root="/repo"
        path="manual.html"
        revealLineStart={2}
        revealLineEnd={3}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("region", { name: "File preview: manual.html" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("aborts a pending source read on retarget and settles its original stage once", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    let resolveFirst: ((value: FilesPreviewResponse) => void) | undefined;
    vi.mocked(fetchFilesPreview).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const view = render(<FilePreview root="/repo" path="first.html" onClose={() => undefined} />);
    const first = vi.mocked(fetchFilesPreview).mock.calls[0];
    expect(first?.[3]?.aborted).toBe(false);
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce(textPreview("/repo", "second.html"));
    view.rerender(<FilePreview root="/repo" path="second.html" onClose={() => undefined} />);
    await screen.findByRole("region", { name: "File preview: second.html" });
    expect(first?.[3]?.aborted).toBe(true);
    resolveFirst?.(textPreview("/repo", "first.html", "stale confidential body"));
    await waitFor(() =>
      expect(
        writer.mock.calls.filter(
          (call) =>
            call[1]?.correlationId === first?.[2] && call[1]?.stageReport?.phase === "settled",
        ),
      ).toHaveLength(1),
    );
    expect(
      writer.mock.calls.find(
        (call) =>
          call[1]?.correlationId === first?.[2] && call[1]?.stageReport?.phase === "settled",
      )?.[1]?.stageReport,
    ).toMatchObject({ navigationOutcome: "cancelled" });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("confidential");
    expect(document.body).not.toHaveTextContent("stale confidential body");
  });

  it.each(["text", "image", "binary"] as const)(
    "records the actual %s preview lifecycle",
    async (kind) => {
      const writer = vi.fn();
      setClientDiagnosticWriter(writer);
      const base = textPreview();
      const response: FilesPreviewResponse =
        kind === "text"
          ? base
          : kind === "image"
            ? { ...base, kind, url: "/api/files/image" }
            : { ...base, kind, reason: "unsupported" };
      vi.mocked(fetchFilesPreview).mockResolvedValueOnce(response);
      render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
      await waitFor(() => expect(writer.mock.calls).toHaveLength(2));
      const id = vi.mocked(fetchFilesPreview).mock.calls[0]?.[2];
      expect(writer.mock.calls[0]?.[1]).toMatchObject({
        correlationId: id,
        stageReport: { stage: "files source preview", phase: "started" },
      });
      expect(writer.mock.calls[1]?.[1]).toMatchObject({
        correlationId: id,
        stageReport: {
          stage: "files source preview",
          phase: "settled",
          navigationOutcome: "applied",
          preview: {
            previewKind: kind,
            sourceTextBytesRead: kind === "text" ? base.sizeBytes : 0,
            canEdit: false,
          },
        },
      });
      expect(JSON.stringify(writer.mock.calls)).not.toContain(base.content);
      expect(JSON.stringify(writer.mock.calls)).not.toContain(base.path);
    },
  );

  it.each([false, true])(
    "settles rejected or mismatched previews as failed (mismatch=%s)",
    async (mismatch) => {
      const writer = vi.fn();
      setClientDiagnosticWriter(writer);
      if (mismatch) vi.mocked(fetchFilesPreview).mockResolvedValueOnce(textPreview("/other"));
      else
        vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new TypeError("private read failure"));
      render(<FilePreview root="/repo" path="manual.html" onClose={() => undefined} />);
      await screen.findByRole("alert");
      const stages = writer.mock.calls.filter((call) => call[1]?.stageReport !== undefined);
      const id = vi.mocked(fetchFilesPreview).mock.calls[0]?.[2];
      expect(stages).toHaveLength(2);
      expect(stages[1]?.[1]).toMatchObject({
        correlationId: id,
        stageReport: {
          stage: "files source preview",
          phase: "settled",
          navigationOutcome: "failed",
        },
      });
      expect(stages[1]?.[1]?.stageReport.preview).toBeUndefined();
      expect(JSON.stringify(writer.mock.calls)).not.toContain("private read failure");
    },
  );

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

  it("honors a new reveal identity after the user expanded previous lines", async () => {
    const content = Array.from({ length: 183 }, (_, index) => `source ${index + 1}`).join("\n");
    vi.mocked(fetchFilesPreview).mockResolvedValue(textPreview("/repo", "manual.html", content));
    const props = {
      root: "/repo",
      path: "manual.html",
      revealLineStart: 182,
      revealRequestId: "first-reveal",
      onClose: (): void => undefined,
    };
    const view = render(<FilePreview {...props} />);
    const region = await screen.findByRole("region", { name: "File preview: manual.html" });
    expect(region.querySelectorAll(".fpv-line")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Show 176 previous lines" }));
    expect(region.querySelectorAll(".fpv-line")).toHaveLength(183);
    view.rerender(<FilePreview {...{ ...props, revealRequestId: "second-reveal" }} />);
    expect(region.querySelectorAll(".fpv-line")).toHaveLength(7);
  });

  it.each(["previous", "more"] as const)(
    "retains keyboard focus after the last %s batch",
    async (direction) => {
      const content = Array.from({ length: 600 }, (_, index) => `source ${index + 1}`).join("\n");
      vi.mocked(fetchFilesPreview).mockResolvedValue(textPreview("/repo", "manual.html", content));
      render(
        <FilePreview
          root="/repo"
          path="manual.html"
          revealLineStart={direction === "previous" ? 600 : undefined}
          onClose={() => undefined}
        />,
      );
      const region = await screen.findByRole("region", { name: "File preview: manual.html" });
      if (direction === "previous")
        fireEvent.click(screen.getByRole("button", { name: "Show 500 previous lines" }));
      const button = screen.getByRole("button", {
        name: direction === "previous" ? "Show 94 previous lines" : "Show 100 more lines",
      });
      button.focus();
      await userEvent.keyboard("{Enter}");
      expect(region).toHaveFocus();
      expect(
        screen.getByText(direction === "previous" ? "94 lines added." : "100 lines added."),
      ).toBeInTheDocument();
    },
  );

  it("marks and announces the cited range", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValue(
      textPreview(
        "/repo",
        "manual.html",
        Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n"),
      ),
    );
    const props = {
      root: "/repo",
      path: "manual.html",
      revealLineStart: 7,
      revealLineEnd: 10,
      onClose: (): void => undefined,
    };
    render(<FilePreview {...props} />);
    const region = await screen.findByRole("region", { name: "File preview: manual.html" });
    expect(region.querySelector('[aria-current="location"]')).toHaveTextContent("row 7");
    expect(region.querySelectorAll('[data-source-reference="true"]')).toHaveLength(4);
    expect(screen.getByText("Source lines 7–10.")).toBeInTheDocument();
  });

  it("explains a citation outside the source without marking a different line", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValue(textPreview("/repo", "manual.html", "one\ntwo"));
    render(
      <FilePreview
        root="/repo"
        path="manual.html"
        revealLineStart={90}
        onClose={() => undefined}
      />,
    );
    const region = await screen.findByRole("region", { name: "File preview: manual.html" });
    expect(
      screen.getByText("The referenced line 90 is outside this file (2 lines)."),
    ).toBeInTheDocument();
    expect(region.querySelector('[aria-current="location"]')).toBeNull();
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
