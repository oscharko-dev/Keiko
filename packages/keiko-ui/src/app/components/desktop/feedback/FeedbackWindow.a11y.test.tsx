import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  submitFeedbackReportV1,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import { I18nProvider } from "@/lib/i18n";

import { FeedbackWindow } from "./FeedbackWindow";
import { preparedSnapshotWithOptionalDispositions } from "./FeedbackWindow.test-helpers";

function renderFeedback(
  submitReport: typeof submitFeedbackReportV1 = vi
    .fn<typeof submitFeedbackReportV1>()
    .mockResolvedValue({
      outcome: "accepted",
      receipt: {
        receiptId: "A".repeat(22),
        receiptSecret: "A".repeat(43),
        expiresAt: "2026-08-10T00:00:00.000Z",
      },
    }),
) {
  const prepared = preparedSnapshotWithOptionalDispositions();
  const previewReport = vi
    .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
    .mockResolvedValue(prepared);
  const user = userEvent.setup();
  const rendered = render(
    <I18nProvider>
      <FeedbackWindow previewReport={previewReport} submitReport={submitReport} />
    </I18nProvider>,
  );
  return { ...rendered, user, submitReport };
}

async function openPreparedPreview(submitReport?: typeof submitFeedbackReportV1) {
  const rendered = renderFeedback(submitReport);
  await rendered.user.click(
    screen.getByRole("button", { name: "Continue with ordinary feedback" }),
  );
  const form = screen.getByRole("heading", { name: "Share feedback" }).closest("form");
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
  const preview = await screen.findByRole("region", { name: "Sanitized preview" });
  const heading = within(preview).getByRole("heading", { name: "Sanitized preview" });
  await waitFor(() => expect(heading).toHaveFocus());
  return { ...rendered, preview };
}

async function openConfirmation(submitReport?: typeof submitFeedbackReportV1) {
  const rendered = await openPreparedPreview(submitReport);
  await rendered.user.click(within(rendered.preview).getByRole("checkbox"));
  await rendered.user.click(
    within(rendered.preview).getByRole("button", { name: "Continue to submission" }),
  );
  const confirmation = screen.getByRole("region", { name: "Confirm feedback submission" });
  const heading = within(confirmation).getByRole("heading", {
    name: "Confirm feedback submission",
  });
  await waitFor(() => expect(heading).toHaveFocus());
  return { ...rendered, confirmation };
}

describe("FeedbackWindow accessibility", () => {
  it("uses one persistent polite scanning status while marking the form busy", async () => {
    let resolvePreview: ((snapshot: PreparedFeedbackSnapshotV1) => void) | undefined;
    const previewReport = vi.fn<
      (draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>
    >(
      () =>
        new Promise<PreparedFeedbackSnapshotV1>((resolve) => {
          resolvePreview = resolve;
        }),
    );
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

    const scanningStatus = screen.getByTestId("feedback-scanning-status");
    expect(scanningStatus).toHaveAttribute("aria-live", "polite");
    expect(scanningStatus).toHaveAttribute("aria-atomic", "true");
    expect(scanningStatus).toHaveTextContent("Scanning feedback...");
    expect(form).toHaveAttribute("aria-busy", "true");

    resolvePreview?.(preparedSnapshotWithOptionalDispositions());
    await waitFor(() => expect(form).not.toHaveAttribute("aria-busy"));
    expect(scanningStatus).toHaveTextContent("");
  });

  it("focuses the active heading on initial mount and after the security transition", async () => {
    const { user } = renderFeedback();
    const securityHeading = screen.getByRole("heading", { name: "Before you continue" });

    await waitFor(() => expect(securityHeading).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));

    const formHeading = screen.getByRole("heading", { name: "Share feedback" });
    await waitFor(() => expect(formHeading).toHaveFocus());
  });

  it("has an accessible security gate with keyboard-ordered private routing", async () => {
    const { container, user } = renderFeedback();
    const privateLink = screen.getByRole("link", { name: "Report a security issue privately" });
    const ordinary = screen.getByRole("button", { name: "Continue with ordinary feedback" });

    expect(privateLink).toHaveAttribute(
      "href",
      "https://github.com/oscharko-dev/Keiko/security/advisories/new",
    );
    await user.tab();
    expect(privateLink).toHaveFocus();
    await user.tab();
    expect(ordinary).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the ordinary feedback form", async () => {
    const { container, user } = renderFeedback();
    await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));

    expect(screen.getByRole("heading", { name: "Share feedback" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in prepared disposition, exact-payload, and review state", async () => {
    const { container, preview } = await openPreparedPreview();

    expect(within(preview).getByRole("region", { name: "Privacy changes" })).toBeInTheDocument();
    expect(
      within(preview).getByRole("region", { name: "Exact payload for submission" }),
    ).toBeInTheDocument();
    expect(within(preview).getByRole("checkbox")).not.toBeChecked();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("makes the labelled exact-payload scroll region keyboard reachable", async () => {
    const { preview, user } = await openPreparedPreview();
    const exactPayload = within(preview).getByRole("region", {
      name: "Exact payload for submission",
    });
    const heading = within(exactPayload).getByRole("heading", {
      name: "Exact payload for submission",
    });
    const canonicalJson = exactPayload.querySelector("pre");
    expect(canonicalJson).not.toBeNull();
    if (canonicalJson === null) return;

    expect(canonicalJson).toHaveAttribute("tabindex", "0");
    expect(canonicalJson).toHaveAttribute("aria-labelledby", heading.id);
    expect(canonicalJson).toHaveAccessibleName("Exact payload for submission");
    for (let tabs = 0; tabs < 12 && document.activeElement !== canonicalJson; tabs += 1) {
      await user.tab();
    }
    expect(canonicalJson).toHaveFocus();
  });

  it("has no violations in the focused confirmation state", async () => {
    const { container, confirmation } = await openConfirmation();

    expect(within(confirmation).getByRole("button", { name: "Submit feedback" })).toBeEnabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ["rejected", "Feedback submission rejected"],
    ["error", "Feedback submission could not be confirmed"],
  ] as const)("has no violations in the focused %s result", async (kind, name) => {
    const submitReport = vi.fn<typeof submitFeedbackReportV1>();
    if (kind === "rejected") submitReport.mockResolvedValue({ outcome: "rejected" });
    else submitReport.mockRejectedValue(new Error("private-transport-detail"));
    const { container, user, confirmation } = await openConfirmation(submitReport);

    await user.click(within(confirmation).getByRole("button", { name: "Submit feedback" }));
    const result = await screen.findByRole("region", { name });
    await waitFor(() => expect(result).toHaveFocus());
    expect(await axe(container)).toHaveNoViolations();
  });
});
