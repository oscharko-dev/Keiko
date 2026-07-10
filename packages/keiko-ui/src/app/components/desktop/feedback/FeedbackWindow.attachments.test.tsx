import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { FeedbackBrowserDraftV1, PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";
import { FeedbackWindow } from "./FeedbackWindow";
import {
  preparedSnapshotWithAttachmentDispositions,
  preparedSnapshotWithSafeAttachment,
  unreadFile,
} from "./FeedbackWindow.test-helpers";

describe("FeedbackWindow attachment recovery", () => {
  it("stages bounded text attachments as anonymous envelopes and removes one safely", async () => {
    const safeRaw = "Safe attachment remainder.\npassword=opaque-first-source";
    const unsafeRaw = '"password=opaque-second-source"';
    const safeFilename = "customer-safe-notes.txt";
    const unsafeFilename = "customer-unsafe-notes.txt";
    const prepared = preparedSnapshotWithAttachmentDispositions();
    const rescanned = preparedSnapshotWithSafeAttachment();
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(rescanned);
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const attachmentInput = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    const safeFile = new File([safeRaw], safeFilename, {
      type: "text/plain",
      lastModified: 1_700_000_000_000,
    });
    const unsafeFile = new File([unsafeRaw], unsafeFilename, {
      type: "text/plain",
      lastModified: 1_700_000_000_001,
    });
    await user.upload(attachmentInput, [safeFile, unsafeFile]);

    expect(await screen.findByText("Attachment 1")).toBeInTheDocument();
    expect(screen.getByText("Attachment 2")).toBeInTheDocument();
    expect(screen.queryByText(safeFilename)).not.toBeInTheDocument();
    expect(screen.queryByText(unsafeFilename)).not.toBeInTheDocument();
    expect(attachmentInput).toHaveValue("");
    expect(attachmentInput.files).toHaveLength(0);

    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledTimes(1));

    const expectedSafeEnvelope = {
      bytesBase64: btoa(safeRaw),
      declaredMediaType: "text/plain",
      extension: ".txt",
    };
    const expectedUnsafeEnvelope = {
      bytesBase64: btoa(unsafeRaw),
      declaredMediaType: "text/plain",
      extension: ".txt",
    };
    expect(previewReport.mock.calls[0]?.[0].attachments).toEqual([
      expectedSafeEnvelope,
      expectedUnsafeEnvelope,
    ]);
    for (const envelope of previewReport.mock.calls[0]?.[0].attachments ?? []) {
      expect(Object.keys(envelope).sort()).toEqual([
        "bytesBase64",
        "declaredMediaType",
        "extension",
      ]);
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toContain(safeRaw);
      expect(serialized).not.toContain(unsafeRaw);
      expect(serialized).not.toContain(safeFilename);
      expect(serialized).not.toContain(unsafeFilename);
      expect(serialized).not.toContain("lastModified");
      expect(serialized).not.toContain("path");
    }

    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(preview).getByText("Safe attachment remainder.")).toBeInTheDocument();
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    expect(
      within(notices).getByText("Attachment 1: ambiguous credential-like content was quarantined."),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText("Attachment 2: ambiguous credential-like content was quarantined."),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText(
        "Attachment 2: no safe optional content remained, so it was omitted.",
      ),
    ).toBeInTheDocument();
    expect(preview).not.toHaveTextContent(safeRaw);
    expect(preview).not.toHaveTextContent(unsafeRaw);
    expect(preview).not.toHaveTextContent(safeFilename);
    expect(preview).not.toHaveTextContent(unsafeFilename);

    await user.click(screen.getByRole("button", { name: "Remove attachment 2" }));
    expect(screen.getByText("Attachment 1")).toBeInTheDocument();
    expect(screen.queryByText("Attachment 2")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Attachment 2 removed. Scan again to refresh the preview.",
    );
    expect(attachmentInput).toHaveFocus();

    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledTimes(2));
    expect(previewReport.mock.calls[1]?.[0].attachments).toEqual([expectedSafeEnvelope]);
    expect(await screen.findByRole("region", { name: "Sanitized preview" })).toHaveTextContent(
      "Safe attachment remainder.",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("locks scan and removal while staging is in flight", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const attachmentInput = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    await user.upload(attachmentInput, new File(["first"], "first.txt", { type: "text/plain" }));
    expect(await screen.findByText("Attachment 1")).toBeInTheDocument();

    let resolveRead: ((value: ArrayBuffer) => void) | undefined;
    const pendingRead = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const secondFile = new File(["second"], "second.txt", { type: "text/plain" });
    Object.defineProperty(secondFile, "arrayBuffer", {
      value: vi.fn().mockReturnValue(pendingRead),
    });
    await user.upload(attachmentInput, secondFile);

    const scan = screen.getByRole("button", { name: "Scan and preview" });
    const removeFirst = screen.getByRole("button", { name: "Remove attachment 1" });
    expect(scan).toBeDisabled();
    expect(removeFirst).toBeDisabled();
    expect(attachmentInput).toBeDisabled();
    await user.click(removeFirst);
    expect(screen.getByText("Attachment 1")).toBeInTheDocument();

    resolveRead?.(new TextEncoder().encode("second").buffer as ArrayBuffer);
    expect(await screen.findByText("Attachment 2")).toBeInTheDocument();
    expect(scan).toBeEnabled();
    expect(removeFirst).toBeEnabled();
    expect(attachmentInput).toBeEnabled();
  });

  it("retains staged attachments and refocuses the cleared picker after a read failure", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const attachmentInput = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    await user.upload(attachmentInput, new File(["first"], "first.txt", { type: "text/plain" }));
    expect(await screen.findByText("Attachment 1")).toBeInTheDocument();

    const failedRead = vi.fn().mockRejectedValue(new Error("denied"));
    const failedFile = new File(["second"], "second.txt", { type: "text/plain" });
    Object.defineProperty(failedFile, "arrayBuffer", { value: failedRead });
    await user.upload(attachmentInput, failedFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Keiko could not read the selected text attachment.",
    );
    expect(failedRead).toHaveBeenCalledOnce();
    expect(screen.getByText("Attachment 1")).toBeInTheDocument();
    expect(screen.queryByText("Attachment 2")).not.toBeInTheDocument();
    expect(attachmentInput).toHaveValue("");
    expect(attachmentInput.files).toHaveLength(0);
    expect(attachmentInput).toHaveFocus();
  });

  it("passes bounded file metadata through for canonical server policy enforcement", async () => {
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(preparedSnapshotWithSafeAttachment());
    const user = userEvent.setup({ applyAccept: false });
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const attachmentInput = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    await user.upload(attachmentInput, new File(["BM"], "sample.bmp", { type: "image/bmp" }));
    expect(await screen.findByText("Attachment 1")).toBeInTheDocument();

    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());
    expect(previewReport.mock.calls[0]?.[0].attachments).toEqual([
      {
        bytesBase64: btoa("BM"),
        declaredMediaType: "image/bmp",
        extension: ".bmp",
      },
    ]);
  });

  it.each([
    [
      "item",
      () => [unreadFile("oversized.txt", 64 * 1024 + 1)],
      "Each attachment must be 64 KiB or smaller.",
    ],
    [
      "count",
      () => [
        unreadFile("one.txt", 1),
        unreadFile("two.txt", 1),
        unreadFile("three.txt", 1),
        unreadFile("four.txt", 1),
      ],
      "You can add up to 3 attachments.",
    ],
    [
      "aggregate",
      () => [
        unreadFile("one.txt", 44 * 1024),
        unreadFile("two.txt", 44 * 1024),
        unreadFile("three.txt", 44 * 1024),
      ],
      "Attachments must total 128 KiB or less.",
    ],
  ])(
    "rejects attachment limit violations before reading bytes: %s",
    async (_kind, createFiles, expectedMessage) => {
      const user = userEvent.setup();
      render(
        <I18nProvider>
          <FeedbackWindow />
        </I18nProvider>,
      );

      await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
      const attachmentInput = screen.getByLabelText<HTMLInputElement>("Add text attachment");
      const candidates = createFiles();
      await user.upload(
        attachmentInput,
        candidates.map(({ file }) => file),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(expectedMessage);
      for (const { readBytes } of candidates) expect(readBytes).not.toHaveBeenCalled();
      expect(screen.queryByText(/Attachment 1/u)).not.toBeInTheDocument();
      expect(attachmentInput).toHaveValue("");
      expect(attachmentInput.files).toHaveLength(0);
      expect(attachmentInput).toHaveFocus();
    },
  );
});
