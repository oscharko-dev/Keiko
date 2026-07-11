import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import {
  submitFeedbackReportV1,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
  type FeedbackSubmitOutcomeV1,
} from "@/lib/feedback-api";

import { FeedbackWindow } from "./FeedbackWindow";
import {
  preparedSnapshot,
  preparedSnapshotWithOptionalDispositions,
} from "./FeedbackWindow.test-helpers";

const RAW_SENTINEL = "raw-draft-outcome-sentinel";

async function reachConfirmation(
  submitReport: typeof submitFeedbackReportV1,
  prepared: PreparedFeedbackSnapshotV1 = preparedSnapshot(),
  writeClipboard: (text: string) => Promise<void> = () => Promise.resolve(),
) {
  const previewReport = vi
    .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
    .mockResolvedValue(prepared);
  const user = userEvent.setup();
  const rendered = render(
    <I18nProvider>
      <FeedbackWindow
        previewReport={previewReport}
        submitReport={submitReport}
        writeClipboard={writeClipboard}
      />
    </I18nProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
  await user.type(screen.getByLabelText("Product version"), "0.2.14");
  await user.type(screen.getByLabelText("Title"), "Outcome review");
  await user.type(screen.getByLabelText("Description"), RAW_SENTINEL);
  await user.type(screen.getByLabelText("Steps to reproduce"), "Open Settings.");
  await user.type(screen.getByLabelText("Expected result"), "Feedback is reviewed.");
  await user.type(screen.getByLabelText("Actual result"), "Feedback needs review.");
  await user.click(screen.getByRole("button", { name: "Scan and preview" }));
  const preview = await screen.findByRole("region", { name: "Sanitized preview" });
  await user.click(
    within(preview).getByRole("checkbox", {
      name: /reviewed.*exact.*sanitized.*payload/iu,
    }),
  );
  await user.click(within(preview).getByRole("button", { name: "Continue to submission" }));
  const confirmation = screen.getByRole("region", { name: "Confirm feedback submission" });
  return {
    user,
    preview,
    submit: within(confirmation).getByRole("button", { name: "Submit feedback" }),
    unmount: rendered.unmount,
  };
}

describe("FeedbackWindow exact submission", () => {
  const receipt = {
    receiptId: "A".repeat(22),
    receiptSecret: "A".repeat(43),
    expiresAt: "2026-08-10T00:00:00.000Z",
  };

  it("requires review and confirmation before submitting only the exact prepared pair", async () => {
    const prepared = preparedSnapshot();
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(prepared);
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "accepted", receipt });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} submitReport={submitReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    await user.type(screen.getByLabelText("Product version"), "0.2.14");
    await user.type(screen.getByLabelText("Title"), "Bearer");
    await user.type(screen.getByLabelText("Description"), "The login button remained disabled");
    await user.type(screen.getByLabelText("Steps to reproduce"), "Open Settings.");
    await user.type(screen.getByLabelText("Expected result"), "The login flow continues.");
    await user.type(screen.getByLabelText("Actual result"), "The login button stays disabled.");
    await user.click(screen.getByRole("button", { name: "Scan and preview" }));

    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    const previewHeading = within(preview).getByRole("heading", { name: "Sanitized preview" });
    await waitFor(() => expect(previewHeading).toHaveFocus());
    const exactPayload = within(preview).getByRole("region", {
      name: "Exact payload for submission",
    });
    expect(
      within(exactPayload).getByText(prepared.canonicalJson, { selector: "pre" }),
    ).toBeVisible();
    expect(
      within(exactPayload).getByText(prepared.exactBodySha256, { selector: "code" }),
    ).toBeVisible();

    const review = within(preview).getByRole("checkbox", {
      name: /reviewed.*exact.*sanitized.*payload/iu,
    });
    const continueToSubmission = within(preview).getByRole("button", {
      name: "Continue to submission",
    });
    expect(review).not.toBeChecked();
    expect(continueToSubmission).toBeDisabled();
    expect(submitReport).not.toHaveBeenCalled();

    await user.click(review);
    expect(continueToSubmission).toBeEnabled();
    await user.click(continueToSubmission);
    const confirmation = screen.getByRole("region", { name: "Confirm feedback submission" });
    const confirmationHeading = within(confirmation).getByRole("heading", {
      name: "Confirm feedback submission",
    });
    const submit = within(confirmation).getByRole("button", { name: "Submit feedback" });
    await waitFor(() => expect(confirmationHeading).toHaveFocus());
    expect(submitReport).not.toHaveBeenCalled();

    await user.click(submit);
    await waitFor(() => expect(submitReport).toHaveBeenCalledOnce());
    expect(submitReport).toHaveBeenCalledWith({
      canonicalJson: prepared.canonicalJson,
      exactBodySha256: prepared.exactBodySha256,
    });
    expect(Object.keys(submitReport.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "canonicalJson",
      "exactBodySha256",
    ]);
    const accepted = await screen.findByRole("status");
    expect(accepted).toHaveTextContent("Feedback was submitted for maintainer review.");
    await waitFor(() => expect(accepted).toHaveFocus());
    expect(screen.getByRole("button", { name: "Open public GitHub form" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it.each([
    [
      "unavailable outcome",
      "unavailable",
      "Feedback intake unavailable",
      "Keiko intake is currently unavailable. Try again or use the public GitHub form.",
    ],
    [
      "thrown-error outcome",
      "error",
      "Feedback submission could not be confirmed",
      "Keiko could not confirm the submission outcome. Retry only to make another attempt.",
    ],
  ])("renders a focused content-free %s with explicit retry", async (_label, kind, name, copy) => {
    const submitReport = vi.fn<typeof submitFeedbackReportV1>();
    if (kind === "error") submitReport.mockRejectedValue(new Error(RAW_SENTINEL));
    else submitReport.mockResolvedValue({ outcome: kind as "unavailable" });
    const { user, submit } = await reachConfirmation(submitReport);

    await user.click(submit);
    const result = await screen.findByRole("region", { name });
    expect(result).toHaveTextContent(copy);
    expect(result).not.toHaveTextContent(RAW_SENTINEL);
    await waitFor(() => expect(result).toHaveFocus());
    expect(screen.getByRole("button", { name: "Open public GitHub form" })).toBeInTheDocument();
    expect(submitReport).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(submitReport).toHaveBeenCalledOnce();

    await user.click(within(result).getByRole("button", { name: "Retry submission" }));
    await waitFor(() => expect(submitReport).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
  });

  it("requires edit and rescan after rejection instead of offering a same-byte retry", async () => {
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "rejected" });
    const { user, submit } = await reachConfirmation(submitReport);

    await user.click(submit);
    const result = await screen.findByRole("region", { name: "Feedback submission rejected" });
    expect(result).toHaveTextContent("Keiko did not accept this feedback for maintainer review.");
    expect(within(result).queryByRole("button", { name: "Retry submission" })).toBeNull();
    const editAndRescan = within(result).getByRole("button", {
      name: "Edit and rescan feedback",
    });
    await user.click(editAndRescan);
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(submitReport).toHaveBeenCalledOnce();
  });

  it("offers one receipt copy, then clears the in-memory capability", async () => {
    const receipt = {
      receiptId: "A".repeat(22),
      receiptSecret: "A".repeat(43),
      expiresAt: "2026-08-10T00:00:00.000Z",
    };
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "accepted", receipt });
    const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    const { user, submit } = await reachConfirmation(
      submitReport,
      preparedSnapshot(),
      writeClipboard,
    );

    await user.click(submit);
    expect(await screen.findByText(receipt.receiptId)).toBeVisible();
    expect(screen.getByText(receipt.expiresAt)).toBeVisible();
    expect(screen.queryByText(receipt.receiptSecret)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy one-time receipt" }));

    expect(writeClipboard).toHaveBeenCalledWith(
      `Receipt ID: ${receipt.receiptId}\nReceipt secret: ${receipt.receiptSecret}\nExpires at: ${receipt.expiresAt}`,
    );
    expect(await screen.findByText(/Receipt copied.*cleared/iu)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByText(/Receipt copied.*cleared/iu, { selector: "p" })).toHaveFocus(),
    );
    expect(screen.queryByText(receipt.receiptId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy one-time receipt" })).toBeNull();
  });

  it("retains a receipt after clipboard failure and clears it on draft edit", async () => {
    const receipt = {
      receiptId: "A".repeat(22),
      receiptSecret: "A".repeat(43),
      expiresAt: "2026-08-10T00:00:00.000Z",
    };
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "accepted", receipt });
    const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error());
    const { user, submit } = await reachConfirmation(
      submitReport,
      preparedSnapshot(),
      writeClipboard,
    );

    await user.click(submit);
    await user.click(await screen.findByRole("button", { name: "Copy one-time receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("remains available");
    expect(screen.getByText(receipt.receiptId)).toBeVisible();

    await user.type(screen.getByLabelText("Title"), " changed");
    expect(screen.queryByText(receipt.receiptId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy one-time receipt" })).toBeNull();
  });

  it("renders a focused throttled recovery without disclosing policy details", async () => {
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "rate-limited" });
    const { user, submit } = await reachConfirmation(submitReport);

    await user.click(submit);
    const result = await screen.findByRole("region", { name: "Feedback submission paused" });
    expect(within(result).getByText("Warning")).toBeVisible();
    expect(result.querySelector("svg")).toBeInTheDocument();
    expect(result).toHaveTextContent(
      "Keiko cannot accept another submission right now. Try again later or use the public GitHub form.",
    );
    expect(result).not.toHaveTextContent(/limit|threshold|class|minute|hour/iu);
    expect(within(result).queryByRole("button", { name: "Retry submission" })).toBeNull();
    await waitFor(() => expect(result).toHaveFocus());
    await user.click(within(result).getByRole("button", { name: "Edit feedback" }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull();
  });

  it("permits explicit submission after optional quarantine and omission", async () => {
    const submitReport = vi
      .fn<typeof submitFeedbackReportV1>()
      .mockResolvedValue({ outcome: "accepted", receipt });
    const { user, preview, submit } = await reachConfirmation(
      submitReport,
      preparedSnapshotWithOptionalDispositions(),
    );

    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    expect(notices).toHaveTextContent("ambiguous credential-like content was quarantined");
    expect(notices).toHaveTextContent("no safe optional content remained, so it was omitted");
    expect(screen.queryByRole("button", { name: /send anyway/iu })).not.toBeInTheDocument();
    await user.click(submit);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Feedback was submitted for maintainer review.",
    );
    expect(submitReport).toHaveBeenCalledOnce();
  });

  it("locks the final action while an explicit submission is in flight", async () => {
    let resolveSubmission: ((outcome: FeedbackSubmitOutcomeV1) => void) | undefined;
    const pending = new Promise<FeedbackSubmitOutcomeV1>((resolve) => {
      resolveSubmission = resolve;
    });
    const submitReport = vi.fn<typeof submitFeedbackReportV1>().mockReturnValue(pending);
    const { user, submit } = await reachConfirmation(submitReport);

    await user.click(submit);
    expect(submit).toBeDisabled();
    const title = screen.getByLabelText("Title");
    expect(title).toBeDisabled();
    expect(screen.getByLabelText("Category")).toBeDisabled();
    expect(screen.getByLabelText("Add text attachment")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Scan and preview" })).toBeDisabled();

    // Prove the mutation guard independently of the disabled browser control.
    title.removeAttribute("disabled");
    fireEvent.change(title, { target: { value: "Newer draft must stay blocked" } });
    expect(title).toHaveValue("Outcome review");
    expect(screen.getByRole("region", { name: "Confirm feedback submission" })).toBeInTheDocument();
    await user.click(submit);
    expect(submitReport).toHaveBeenCalledOnce();
    resolveSubmission?.({ outcome: "accepted", receipt });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Feedback was submitted for maintainer review.",
    );
    expect(submitReport).toHaveBeenCalledOnce();
  });

  it("disables preview recovery controls while final submission is in flight", async () => {
    let resolveSubmission: ((outcome: FeedbackSubmitOutcomeV1) => void) | undefined;
    const pending = new Promise<FeedbackSubmitOutcomeV1>((resolve) => {
      resolveSubmission = resolve;
    });
    const submitReport = vi.fn<typeof submitFeedbackReportV1>().mockReturnValue(pending);
    const { user, preview, submit } = await reachConfirmation(
      submitReport,
      preparedSnapshotWithOptionalDispositions(),
    );

    await user.click(submit);
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    expect(
      within(notices).getByRole("button", { name: "Edit browser description" }),
    ).toBeDisabled();
    expect(
      within(notices).getByRole("button", { name: "Remove browser description" }),
    ).toBeDisabled();
    expect(within(preview).getByRole("button", { name: "Edit and rescan" })).toBeDisabled();
    resolveSubmission?.({ outcome: "accepted", receipt });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Feedback was submitted for maintainer review.",
    );
  });
});
