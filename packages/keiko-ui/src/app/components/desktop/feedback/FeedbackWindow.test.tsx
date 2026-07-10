import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import {
  FeedbackPreviewPreparationError,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import { FeedbackWindow } from "./FeedbackWindow";
import type { FeedbackPublicOpener } from "./FeedbackPublicHandoff";
import {
  preparedSnapshot,
  preparedSnapshotWithBrowserRemainder,
  preparedSnapshotWithOptionalDispositions,
} from "./FeedbackWindow.test-helpers";

describe("FeedbackWindow", () => {
  it("routes security reports first and preserves separate sanitized summary fields", async () => {
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(preparedSnapshot());
    const revalidateReport = vi.fn().mockResolvedValue({ outcome: "valid" as const });
    const reserved = {
      opener: {} as unknown,
      close: vi.fn<() => void>(),
      document: document.implementation.createHTMLDocument(),
      location: { replace: vi.fn<(url: string) => void>() },
    };
    const openPublic = vi.fn<FeedbackPublicOpener>().mockReturnValue(reserved);
    render(
      <I18nProvider>
        <FeedbackWindow
          previewReport={previewReport}
          revalidateReport={revalidateReport}
          openPublic={openPublic}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Before you continue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report a security issue privately" })).toHaveAttribute(
      "href",
      "https://github.com/oscharko-dev/Keiko/security/advisories/new",
    );
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    expect(screen.getByRole("link", { name: "Report a security issue privately" })).toHaveAttribute(
      "href",
      "https://github.com/oscharko-dev/Keiko/security/advisories/new",
    );
    await user.type(screen.getByLabelText("Title"), "Bearer");
    await user.type(screen.getByLabelText("Description"), "The login button remained disabled");
    await user.type(
      screen.getByLabelText("Steps to reproduce"),
      "Open Settings and select Continue.",
    );
    await user.type(screen.getByLabelText("Expected result"), "The login flow continues.");
    await user.type(screen.getByLabelText("Actual result"), "The login button remained disabled.");
    await user.type(screen.getByLabelText("Product version"), "0.2.14");
    await user.click(screen.getByRole("button", { name: "Scan and preview" }));

    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());
    expect(previewReport.mock.calls[0]?.[0]).toMatchObject({
      title: "Bearer",
      description: "The login button remained disabled",
    });
    const preview = screen.getByRole("region", { name: "Sanitized preview" });
    expect(
      within(preview).getByText(
        "Deterministic scanning can miss proprietary or customer data. Review the complete outbound text before submitting or opening GitHub.",
      ),
    ).toBeVisible();
    const title = within(preview).getByText("Bearer");
    const description = within(preview).getByText("The login button remained disabled");
    expect(title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    const publicAction = screen.getByRole("button", { name: "Open public GitHub form" });
    expect(screen.queryByRole("textbox", { name: "Complete sanitized report" })).toBeNull();
    await user.click(publicAction);
    await waitFor(() => expect(reserved.location.replace).toHaveBeenCalledOnce());
    expect(
      new URL(
        reserved.location.replace.mock.calls[0]?.[0] ?? "",
        window.location.href,
      ).searchParams.get("summary"),
    ).toBe("Bearer\n\nThe login button remained disabled");
    expect(reserved.opener).toBeNull();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("keeps the draft and focuses a required field that needs a safe rewrite", async () => {
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockRejectedValue(
        new FeedbackPreviewPreparationError([
          {
            code: "rewrite-required",
            target: { kind: "draft-field", field: "description" },
          },
        ]),
      );
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    await user.type(screen.getByLabelText("Product version"), "0.2.14");
    await user.type(screen.getByLabelText("Title"), "Credential setup is blocked");
    const description = screen.getByLabelText("Description");
    await user.type(description, "Authorization: Bearer ambiguous-value");
    await user.type(screen.getByLabelText("Steps to reproduce"), "Open model settings.");
    await user.type(screen.getByLabelText("Expected result"), "Setup continues.");
    await user.type(screen.getByLabelText("Actual result"), "Setup remains blocked.");
    await user.click(screen.getByRole("button", { name: "Scan and preview" }));

    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());
    await waitFor(() => expect(description).toHaveFocus());
    expect(description).toHaveValue("Authorization: Bearer ambiguous-value");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Rewrite the required field, then scan again. Nothing has left this device.",
    );
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("targets raw-log rejection with handwritten sanitized-summary recovery", async () => {
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockRejectedValue(
        new FeedbackPreviewPreparationError([
          { code: "raw-log-content", field: "handwrittenEvidence" },
        ]),
      );
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const evidence = screen.getByLabelText("Handwritten evidence (optional)");
    await user.type(evidence, "2026-07-10 ERROR raw record");
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    screen.getByRole("button", { name: "Scan and preview" }).focus();
    fireEvent.submit(form!);

    await waitFor(() => expect(evidence).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Raw logs cannot be submitted. Replace them with a handwritten sanitized evidence summary, then scan again.",
    );
  });

  it.each([
    [
      "unsafe controls",
      { code: "unsafe-control", field: "steps" } as const,
      "Steps to reproduce",
      "The affected text contains unsupported control or formatting characters. Remove them, then scan again.",
    ],
    [
      "binary attachment content",
      { code: "binary-signature", field: "attachments" } as const,
      "Add text attachment",
      "The selected attachment is not supported as safe text. Remove it or choose a supported text file, then scan again.",
    ],
    [
      "attachment media type",
      { code: "unsupported-media-type", field: "attachments" } as const,
      "Add text attachment",
      "The selected attachment is not supported as safe text. Remove it or choose a supported text file, then scan again.",
    ],
    [
      "attachment extension",
      { code: "unsupported-extension", field: "attachments" } as const,
      "Add text attachment",
      "The selected attachment is not supported as safe text. Remove it or choose a supported text file, then scan again.",
    ],
    [
      "attachment size limits",
      { code: "attachment-aggregate-byte-limit", field: "attachments" } as const,
      "Add text attachment",
      "Feedback exceeds a size limit. Shorten the affected content or remove attachments, then scan again.",
    ],
    [
      "field byte limits",
      { code: "field-byte-limit", field: "steps" } as const,
      "Steps to reproduce",
      "Feedback exceeds a size limit. Shorten the affected content or remove attachments, then scan again.",
    ],
  ])("targets %s with content-free recovery", async (_label, error, controlName, message) => {
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockRejectedValue(new FeedbackPreviewPreparationError([error]));
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const target = screen.getByLabelText(controlName);
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    screen.getByRole("button", { name: "Scan and preview" }).focus();
    fireEvent.submit(form!);

    await waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it.each([
    ["a generic preview failure", new Error("synthetic transport detail")],
    [
      "a rewrite target without a rendered control",
      new FeedbackPreviewPreparationError([
        { code: "rewrite-required", target: { kind: "attachment", ordinal: 0 } },
      ]),
    ],
  ])("focuses the form heading for %s", async (_label, failure) => {
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockRejectedValue(failure);
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const heading = screen.getByRole("heading", { name: "Share feedback" });
    const form = heading.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("renders content-free optional disposition recovery without blocking safe remainder", async () => {
    const rawSentinel = "opaque-browser-source-must-stay-local";
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(preparedSnapshotWithOptionalDispositions());
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(preview).getByText("The login button remained disabled.")).toBeInTheDocument();
    const notices = screen.getByRole("region", { name: "Privacy changes" });
    expect(
      within(notices).getByText("Browser description: sensitive content was redacted."),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText(
        "Browser description: ambiguous credential-like content was quarantined.",
      ),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText(
        "Browser description: no safe optional content remained, so it was omitted.",
      ),
    ).toBeInTheDocument();
    expect(within(notices).getByRole("button", { name: "Edit browser description" })).toBeEnabled();
    expect(notices).not.toHaveTextContent(rawSentinel);
    expect(preview).not.toHaveTextContent(rawSentinel);
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("keeps raw browser text local while editing a sanitized browser remainder", async () => {
    const rawSentinel = "Safe prefix password=opaque-browser-source";
    const prepared = preparedSnapshotWithBrowserRemainder();
    const user = userEvent.setup();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(prepared);
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const browserDraft = screen.getByLabelText("Browser description (optional)");
    await user.type(browserDraft, rawSentinel);
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(preview).getByText("Firefox safe remainder.")).toBeInTheDocument();
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    expect(preview).not.toHaveTextContent(rawSentinel);
    expect(notices).not.toHaveTextContent(rawSentinel);
    expect(previewReport.mock.calls[0]?.[0]).toMatchObject({ browserDescription: rawSentinel });

    await user.click(within(notices).getByRole("button", { name: "Edit browser description" }));
    expect(browserDraft).toHaveFocus();
    expect(browserDraft).toHaveValue(rawSentinel);
    expect(prepared.report.browserDescription).toBe("Firefox safe remainder.");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("locks draft controls and drops a stale preview when the draft changes in flight", async () => {
    let resolvePreview: ((snapshot: PreparedFeedbackSnapshotV1) => void) | undefined;
    const pendingPreview = new Promise<PreparedFeedbackSnapshotV1>((resolve) => {
      resolvePreview = resolve;
    });
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockReturnValue(pendingPreview);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());

    const title = screen.getByLabelText("Title");
    expect(title).toBeDisabled();
    expect(screen.getByLabelText("Category")).toBeDisabled();
    expect(screen.getByLabelText("Add text attachment")).toBeDisabled();

    // Exercise the request-generation guard independently of the disabled UI control.
    title.removeAttribute("disabled");
    fireEvent.change(title, { target: { value: "Newer local title" } });
    expect(title).toHaveValue("Newer local title");
    resolvePreview?.(preparedSnapshot());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan and preview" })).toBeEnabled(),
    );
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).not.toBeInTheDocument();
  });

  it("settles busy state without surfacing a stale preview error after a select change", async () => {
    let rejectPreview: ((cause: unknown) => void) | undefined;
    const pendingPreview = new Promise<PreparedFeedbackSnapshotV1>((_resolve, reject) => {
      rejectPreview = reject;
    });
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockReturnValue(pendingPreview);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());

    const category = screen.getByLabelText("Category");
    expect(category).toBeDisabled();
    category.removeAttribute("disabled");
    fireEvent.change(category, { target: { value: "performance" } });
    rejectPreview?.(new Error("stale-private-preview-error"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Scan and preview" })).toBeEnabled(),
    );
    expect(category).toHaveValue("performance");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull();
  });
});
