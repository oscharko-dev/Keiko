import type {
  FeedbackDispositionRecordV1,
  FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  submitFeedbackReportV1,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import { I18nProvider } from "@/lib/i18n";

import { FeedbackWindow } from "./FeedbackWindow";
import {
  preparedSnapshot,
  preparedSnapshotWithAttachmentDispositions,
  preparedSnapshotWithLeadingAttachmentOmission,
  preparedSnapshotWithOptionalDispositions,
} from "./FeedbackWindow.test-helpers";

const RAW_SENTINEL = "raw-optional-recovery-sentinel";

function handwrittenSnapshot(remainder?: string): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report: FeedbackReportV1 = Object.freeze({
    ...base.report,
    ...(remainder === undefined ? {} : { handwrittenEvidence: remainder }),
  });
  const target = { kind: "draft-field", field: "handwrittenEvidence" } as const;
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "line-remainder",
      target,
    },
    ...(remainder === undefined
      ? [
          {
            action: "omitted" as const,
            reason: "no-safe-optional-content" as const,
            unitKind: "optional-field" as const,
            target,
          },
        ]
      : []),
  ];
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

function titleDispositionSnapshot(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "redacted",
      reason: "complete-sensitive-span",
      unitKind: "structured-value",
      target: { kind: "draft-field", field: "title" },
    },
  ];
  return Object.freeze({
    ...base,
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

function renderFeedback(prepared: PreparedFeedbackSnapshotV1) {
  const previewReport = vi
    .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
    .mockResolvedValue(prepared);
  const submitReport = vi.fn<typeof submitFeedbackReportV1>();
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <FeedbackWindow previewReport={previewReport} submitReport={submitReport} />
    </I18nProvider>,
  );
  return { user, previewReport, submitReport };
}

async function fillRequiredDraft(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
  await user.type(screen.getByLabelText("Product version"), "0.2.14");
  await user.type(screen.getByLabelText("Title"), "Recovery review");
  await user.type(screen.getByLabelText("Description"), "Safe prepared description");
  await user.type(screen.getByLabelText("Steps to reproduce"), "Open Settings.");
  await user.type(screen.getByLabelText("Expected result"), "Recovery succeeds.");
  await user.type(screen.getByLabelText("Actual result"), "Recovery is required.");
}

async function scanPreview(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Scan and preview" }));
  return screen.findByRole("region", { name: "Sanitized preview" });
}

describe("FeedbackWindow recovery completion", () => {
  it("keeps required redaction navigation editable without a removal action", async () => {
    const { user } = renderFeedback(titleDispositionSnapshot());
    await fillRequiredDraft(user);
    const title = screen.getByLabelText("Title");
    const preview = await scanPreview(user);
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });

    expect(within(notices).queryByRole("button", { name: /remove title/iu })).toBeNull();
    await user.click(within(notices).getByRole("button", { name: /edit title/iu }));
    expect(title).toHaveFocus();
    expect(title).toHaveValue("Recovery review");
  });

  it("returns to the draft and invalidates attestation when any draft field changes", async () => {
    const { user, previewReport, submitReport } = renderFeedback(preparedSnapshot());
    await fillRequiredDraft(user);
    const preview = await scanPreview(user);
    await user.click(within(preview).getByRole("checkbox"));
    await user.click(within(preview).getByRole("button", { name: "Continue to submission" }));
    expect(screen.getByRole("region", { name: "Confirm feedback submission" })).toBeInTheDocument();

    await user.click(within(preview).getByRole("button", { name: "Edit and rescan" }));
    const formHeading = screen.getByRole("heading", { name: "Share feedback" });
    expect(formHeading).toHaveFocus();
    await user.type(screen.getByLabelText("Title"), " changed");
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Confirm feedback submission" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan and preview" }));
    const rescanned = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(rescanned).getByRole("checkbox")).not.toBeChecked();
    expect(previewReport).toHaveBeenCalledTimes(2);
    expect(submitReport).not.toHaveBeenCalled();
  });

  it("renders only sanitized handwritten evidence and lets its notice focus the draft", async () => {
    const prepared = handwrittenSnapshot("Safe handwritten remainder.");
    const { user } = renderFeedback(prepared);
    await fillRequiredDraft(user);
    const evidence = screen.getByLabelText("Handwritten evidence (optional)");
    await user.type(evidence, RAW_SENTINEL);
    const preview = await scanPreview(user);

    expect(within(preview).getByText("Safe handwritten remainder.")).toBeInTheDocument();
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    expect(notices).toHaveTextContent(
      "Handwritten evidence: ambiguous credential-like content was quarantined.",
    );
    expect(preview).not.toHaveTextContent(RAW_SENTINEL);
    expect(notices).not.toHaveTextContent(RAW_SENTINEL);
    await user.click(within(notices).getByRole("button", { name: "Edit handwritten evidence" }));
    expect(evidence).toHaveFocus();
    expect(evidence).toHaveValue(RAW_SENTINEL);
  });

  it.each([
    [
      "browser description",
      "browserDescription",
      "Browser description (optional)",
      preparedSnapshotWithOptionalDispositions,
    ],
    [
      "handwritten evidence",
      "handwrittenEvidence",
      "Handwritten evidence (optional)",
      () => handwrittenSnapshot(),
    ],
  ] as const)(
    "removes %s from the transient draft before the next scan",
    async (label, field, controlLabel, makePrepared) => {
      const { user, previewReport, submitReport } = renderFeedback(makePrepared());
      await fillRequiredDraft(user);
      const control = screen.getByLabelText(controlLabel);
      await user.type(control, RAW_SENTINEL);
      const preview = await scanPreview(user);
      const notices = within(preview).getByRole("region", { name: "Privacy changes" });
      expect(within(notices).getByRole("button", { name: `Edit ${label}` })).toBeEnabled();

      await user.click(within(notices).getByRole("button", { name: `Remove ${label}` }));
      expect(screen.queryByRole("region", { name: "Sanitized preview" })).not.toBeInTheDocument();
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(
        `${label[0]?.toUpperCase()}${label.slice(1)} removed from the local draft. Scan again to refresh the preview.`,
      );
      expect(status).not.toHaveTextContent(RAW_SENTINEL);
      expect(control).toHaveFocus();
      expect(control).toHaveValue("");

      await user.click(screen.getByRole("button", { name: "Scan and preview" }));
      await waitFor(() => expect(previewReport).toHaveBeenCalledTimes(2));
      expect(previewReport.mock.calls[1]?.[0]).not.toHaveProperty(field);
      const rescanned = await screen.findByRole("region", { name: "Sanitized preview" });
      expect(within(rescanned).getByRole("checkbox")).not.toBeChecked();
      expect(rescanned).not.toHaveTextContent(RAW_SENTINEL);
      expect(submitReport).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
    },
  );

  it("navigates each affected source ordinal to its anonymous attachment control", async () => {
    const { user } = renderFeedback(preparedSnapshotWithAttachmentDispositions());
    await fillRequiredDraft(user);
    const picker = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    await user.upload(picker, [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]);
    expect(await screen.findByText("Attachment 2")).toBeInTheDocument();
    const preview = await scanPreview(user);
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });

    expect(within(notices).queryByRole("button", { name: /remove attachment/iu })).toBeNull();
    const removeFirst = screen.getByRole("button", { name: "Remove attachment 1" });
    const removeSecond = screen.getByRole("button", { name: "Remove attachment 2" });
    const reviewFirst = within(notices).getByRole("button", { name: "Review attachment 1" });
    const reviewSecond = within(notices).getByRole("button", { name: "Review attachment 2" });
    expect(within(notices).getAllByRole("button", { name: /review attachment/iu })).toHaveLength(2);

    await user.click(reviewFirst);
    expect(removeFirst).toHaveFocus();
    await user.click(reviewSecond);
    expect(removeSecond).toHaveFocus();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("keeps a surviving attachment labelled with its original source ordinal", async () => {
    const { user } = renderFeedback(preparedSnapshotWithLeadingAttachmentOmission());
    await fillRequiredDraft(user);
    const picker = screen.getByLabelText<HTMLInputElement>("Add text attachment");
    await user.upload(picker, [
      new File(["unsafe"], "first.txt", { type: "text/plain" }),
      new File(["safe"], "second.txt", { type: "text/plain" }),
    ]);
    const preview = await scanPreview(user);
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });

    expect(notices).toHaveTextContent(
      "Attachment 1: no safe optional content remained, so it was omitted.",
    );
    expect(within(preview).getByText("Attachment 2")).toBeInTheDocument();
    expect(within(preview).queryByText("Attachment 1")).toBeNull();
  });

  it("allows safe optional omission to continue without a bypass", async () => {
    const { user, submitReport } = renderFeedback(preparedSnapshotWithOptionalDispositions());
    await fillRequiredDraft(user);
    await user.type(screen.getByLabelText("Browser description (optional)"), RAW_SENTINEL);
    const preview = await scanPreview(user);
    await user.click(within(preview).getByRole("checkbox"));
    await user.click(within(preview).getByRole("button", { name: "Continue to submission" }));

    expect(screen.getByRole("region", { name: "Confirm feedback submission" })).toBeInTheDocument();
    expect(submitReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });
});
