import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { FeedbackBrowserDraftV1, PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";

import { FeedbackWindow } from "./FeedbackWindow";
import { preparedSnapshot } from "./FeedbackWindow.test-helpers";

describe("FeedbackWindow draft shape", () => {
  it("omits untouched optional fields from the initial preview request", async () => {
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(preparedSnapshot());
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
    expect(previewReport.mock.calls[0]?.[0]).not.toHaveProperty("browserDescription");
    expect(previewReport.mock.calls[0]?.[0]).not.toHaveProperty("handwrittenEvidence");
    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(preview).queryByRole("region", { name: "Privacy changes" })).toBeNull();
  });

  it("deletes optional draft properties when their controlled inputs are cleared", async () => {
    const previewReport = vi
      .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
      .mockResolvedValue(preparedSnapshot());
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
    const browser = screen.getByLabelText("Browser description (optional)");
    const evidence = screen.getByLabelText("Handwritten evidence (optional)");
    await user.type(browser, "Temporary browser detail");
    await user.clear(browser);
    await user.type(evidence, "Temporary evidence detail");
    await user.clear(evidence);
    expect(browser).toHaveValue("");
    expect(evidence).toHaveValue("");

    const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(previewReport).toHaveBeenCalledOnce());
    expect(previewReport.mock.calls[0]?.[0]).not.toHaveProperty("browserDescription");
    expect(previewReport.mock.calls[0]?.[0]).not.toHaveProperty("handwrittenEvidence");
    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    expect(within(preview).queryByRole("region", { name: "Privacy changes" })).toBeNull();
  });
});
