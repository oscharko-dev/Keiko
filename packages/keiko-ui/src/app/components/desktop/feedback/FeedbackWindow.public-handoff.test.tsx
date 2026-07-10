import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FeedbackBrowserDraftV1, PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";
import {
  createFeedbackPublicProjectionV1,
  PUBLIC_FEEDBACK_FORM_URL_V1,
} from "@/lib/feedback-public-projection";
import { I18nProvider } from "@/lib/i18n";

import { FeedbackWindow } from "./FeedbackWindow";
import type { FeedbackPublicOpener, FeedbackRevalidator } from "./FeedbackPublicHandoff";
import type { FeedbackReservedWindow } from "./feedback-public-window";
import {
  preparedSnapshot,
  preparedSnapshotWithOptionalDispositions,
} from "./FeedbackWindow.test-helpers";

const RAW_SENTINEL = "raw-public-handoff-sentinel";
const QUARANTINE_SENTINEL = "quarantined-private-sentinel";

function reservedWindow() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    document: document.implementation.createHTMLDocument(),
    location: { replace: vi.fn<(url: string) => void>() },
  } satisfies FeedbackReservedWindow;
}

function oversizedSnapshot(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report = Object.freeze({
    ...base.report,
    actualResult: `oversize-sanitized-${"ü".repeat(2_000)}`,
  });
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
  });
}

function renderFeedback(
  prepared: PreparedFeedbackSnapshotV1,
  writeClipboard: (text: string) => Promise<void>,
  revalidateReport: FeedbackRevalidator = vi.fn().mockResolvedValue({ outcome: "valid" as const }),
  requestedOpener?: FeedbackPublicOpener,
) {
  const previewReport = vi
    .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
    .mockResolvedValue(prepared);
  const reserved = reservedWindow();
  const openPublic = requestedOpener ?? vi.fn<FeedbackPublicOpener>().mockReturnValue(reserved);
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <FeedbackWindow
        previewReport={previewReport}
        revalidateReport={revalidateReport}
        writeClipboard={writeClipboard}
        openPublic={openPublic}
      />
    </I18nProvider>,
  );
  return { user, previewReport, revalidateReport, openPublic, reserved };
}

async function preparePreview(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
  await user.type(screen.getByLabelText("Product version"), "0.2.14");
  await user.type(screen.getByLabelText("Title"), RAW_SENTINEL);
  await user.type(screen.getByLabelText("Description"), RAW_SENTINEL);
  await user.type(screen.getByLabelText("Steps to reproduce"), "Open Settings.");
  await user.type(screen.getByLabelText("Expected result"), "Public handoff is safe.");
  await user.type(screen.getByLabelText("Actual result"), RAW_SENTINEL);
  await user.click(screen.getByRole("button", { name: "Scan and preview" }));
  return screen.findByRole("region", { name: "Sanitized preview" });
}

function expectContentFree(element: HTMLElement): void {
  expect(element).not.toHaveTextContent(RAW_SENTINEL);
  expect(element).not.toHaveTextContent(QUARANTINE_SENTINEL);
}

describe("FeedbackWindow public handoff", () => {
  it.each(["success", "error"] as const)(
    "keeps the copy action focused through deferred clipboard %s",
    async (outcome) => {
      let resolveCopy: (() => void) | undefined;
      let rejectCopy: ((cause: unknown) => void) | undefined;
      const pendingCopy = new Promise<void>((resolve, reject) => {
        resolveCopy = resolve;
        rejectCopy = reject;
      });
      const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockReturnValue(pendingCopy);
      const { user } = renderFeedback(oversizedSnapshot(), writeClipboard);
      const preview = await preparePreview(user);
      const copyButton = within(preview).getByRole("button", { name: "Copy sanitized report" });

      await user.click(copyButton);
      await waitFor(() => expect(writeClipboard).toHaveBeenCalledOnce());
      expect(copyButton).toHaveTextContent("Copying sanitized report...");
      expect(copyButton).not.toBeDisabled();
      expect(copyButton).toHaveAttribute("aria-disabled", "true");
      expect(copyButton).toHaveFocus();
      await user.click(copyButton);
      expect(writeClipboard).toHaveBeenCalledOnce();

      if (outcome === "success") resolveCopy?.();
      else rejectCopy?.(new Error(QUARANTINE_SENTINEL));
      const result = await within(preview).findByRole(outcome === "success" ? "status" : "alert");
      expect(copyButton).toHaveFocus();
      expect(copyButton).not.toHaveAttribute("aria-disabled");
      expectContentFree(result);
    },
  );

  it("copies the complete deterministic sanitized fallback beside a template-only link", async () => {
    const prepared = oversizedSnapshot();
    const projection = createFeedbackPublicProjectionV1(prepared.report);
    const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const { user, openPublic, reserved } = renderFeedback(prepared, writeClipboard);
    const preview = await preparePreview(user);

    expect(projection.mode).toBe("copy-fallback");
    const publicAction = within(preview).getByRole("button", {
      name: "Open public GitHub form",
    });
    expect(
      within(preview).queryByRole("textbox", { name: "Complete sanitized report" }),
    ).toBeNull();
    await user.click(publicAction);
    await waitFor(() =>
      expect(reserved.location.replace).toHaveBeenCalledExactlyOnceWith(
        PUBLIC_FEEDBACK_FORM_URL_V1,
      ),
    );
    expect(openPublic).toHaveBeenCalledOnce();
    expect(reserved.opener).toBeNull();
    expect(reserved.close).not.toHaveBeenCalled();
    const openingStatus = reserved.document.body.querySelector('[role="status"]');
    expect(reserved.document.title).toBe("Opening public GitHub form");
    expect(openingStatus?.getAttribute("aria-live")).toBe("polite");
    expect(openingStatus?.getAttribute("aria-atomic")).toBe("true");
    expect(openingStatus?.textContent).toBe("Opening public GitHub form…");
    expect(reserved.document.body.textContent).not.toContain(RAW_SENTINEL);
    expect(reserved.document.body.textContent).not.toContain(QUARANTINE_SENTINEL);
    expect(reserved.document.body.textContent).not.toContain(PUBLIC_FEEDBACK_FORM_URL_V1);
    const selectable = within(preview).getByRole("textbox", {
      name: "Complete sanitized report",
    });
    expect(selectable).toHaveAttribute("readonly");
    expect(selectable).toHaveValue(projection.copyText);
    expect((selectable as HTMLTextAreaElement).value.endsWith(projection.copyText.slice(-80))).toBe(
      true,
    );

    const copyButton = within(preview).getByRole("button", { name: "Copy sanitized report" });
    await user.click(copyButton);
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(projection.copyText);
    const status = within(preview).getByRole("status");
    expect(status).toHaveTextContent("Sanitized report copied.");
    expect(copyButton).toHaveFocus();
    expectContentFree(publicAction);
    expectContentFree(selectable);
    expectContentFree(status);
  });

  it("keeps the full sanitized fallback selectable after clipboard failure", async () => {
    const prepared = oversizedSnapshot();
    const projection = createFeedbackPublicProjectionV1(prepared.report);
    const writeClipboard = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error(QUARANTINE_SENTINEL));
    const { user } = renderFeedback(prepared, writeClipboard);
    const preview = await preparePreview(user);
    const copyButton = within(preview).getByRole("button", { name: "Copy sanitized report" });
    await user.click(copyButton);
    const alert = await within(preview).findByRole("alert");
    const selectable = within(preview).getByRole("textbox", {
      name: "Complete sanitized report",
    });
    expect(alert).toHaveTextContent(
      "Keiko could not copy the sanitized report. Select the full text and copy it manually.",
    );
    expect(selectable).toHaveValue(projection.copyText);
    expect(selectable).toHaveAttribute("readonly");
    expect(copyButton).toHaveFocus();
    expectContentFree(alert);
    expectContentFree(selectable);
  });

  it("keeps normal prefilled parity and always offers the complete sanitized copy", async () => {
    const prepared = preparedSnapshot();
    const projection = createFeedbackPublicProjectionV1(prepared.report);
    const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const { user, openPublic, reserved } = renderFeedback(prepared, writeClipboard);
    const preview = await preparePreview(user);
    const publicAction = within(preview).getByRole("button", {
      name: "Open public GitHub form",
    });
    expect(
      within(preview).queryByRole("textbox", { name: "Complete sanitized report" }),
    ).toBeNull();
    await user.click(publicAction);
    await waitFor(() => expect(reserved.location.replace).toHaveBeenCalledOnce());
    const url = new URL(reserved.location.replace.mock.calls[0]?.[0] ?? "", window.location.href);
    expect(openPublic).toHaveBeenCalledOnce();
    expect(reserved.opener).toBeNull();

    expect(url.searchParams.get("summary")).toBe("Bearer\n\nThe login button remained disabled");
    expect(url.searchParams.get("evidence")).toContain(
      "Diagnostics:\nCategory: defect\nFeature area: model-configuration",
    );
    expect(url.searchParams.has("platform")).toBe(false);
    expect(url.searchParams.has("impact")).toBe(false);
    expect(within(preview).getByRole("textbox", { name: "Complete sanitized report" })).toHaveValue(
      projection.copyText,
    );
    expect(projection.copyText).toContain("Platform:\nLinux");
    expect(projection.copyText).toContain("User impact:\nDegrades core workflow");
    const copyButton = within(preview).getByRole("button", { name: "Copy sanitized report" });
    await user.click(copyButton);
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(projection.copyText);
    expectContentFree(publicAction);
  });

  it.each(["null", "throw", "init"] as const)(
    "shows explicit copy recovery without validating when reservation returns %s",
    async (failure) => {
      const revalidateReport = vi.fn<FeedbackRevalidator>();
      const blocked = vi.fn<FeedbackPublicOpener>();
      let failedReservation: ReturnType<typeof reservedWindow> | undefined;
      if (failure === "null") blocked.mockReturnValue(null);
      else if (failure === "throw")
        blocked.mockImplementation(() => {
          throw new Error(QUARANTINE_SENTINEL);
        });
      else {
        failedReservation = reservedWindow();
        Object.defineProperty(failedReservation, "document", {
          get: () => {
            throw new Error(QUARANTINE_SENTINEL);
          },
        });
        blocked.mockReturnValue(failedReservation);
      }
      const { user } = renderFeedback(
        preparedSnapshot(),
        vi.fn().mockResolvedValue(undefined),
        revalidateReport,
        blocked,
      );
      const preview = await preparePreview(user);

      await user.click(within(preview).getByRole("button", { name: "Open public GitHub form" }));

      expect(blocked).toHaveBeenCalledOnce();
      expect(revalidateReport).not.toHaveBeenCalled();
      if (failedReservation !== undefined) expect(failedReservation.close).toHaveBeenCalledOnce();
      const alert = within(preview).getByRole("alert");
      expect(alert).toHaveTextContent("Your browser blocked the GitHub window");
      expect(alert).not.toHaveTextContent(QUARANTINE_SENTINEL);
      expect(within(preview).getByRole("button", { name: "Copy sanitized report" })).toBeEnabled();
      expect(
        within(preview).queryByRole("textbox", { name: "Complete sanitized report" }),
      ).toBeNull();
    },
  );

  it.each(["rejected", "security"] as const)(
    "closes the blank reservation after %s live revalidation",
    async (outcome) => {
      const revalidateReport = vi.fn<FeedbackRevalidator>().mockResolvedValue({ outcome });
      const { user, reserved } = renderFeedback(
        preparedSnapshot(),
        vi.fn().mockResolvedValue(undefined),
        revalidateReport,
      );
      const preview = await preparePreview(user);

      await user.click(within(preview).getByRole("button", { name: "Open public GitHub form" }));
      await waitFor(() => expect(reserved.close).toHaveBeenCalledOnce());

      expect(reserved.opener).toBeNull();
      expect(reserved.location.replace).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull();
    },
  );

  it("drops a deferred public open when an edit invalidates the prepared digest", async () => {
    let resolveValidation: ((value: { readonly outcome: "valid" }) => void) | undefined;
    const pending = new Promise<{ readonly outcome: "valid" }>((resolve) => {
      resolveValidation = resolve;
    });
    const revalidateReport = vi.fn<FeedbackRevalidator>().mockReturnValue(pending);
    const reserved = reservedWindow();
    const openPublic = vi.fn<FeedbackPublicOpener>().mockReturnValue(reserved);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <FeedbackWindow
          previewReport={vi.fn().mockResolvedValue(preparedSnapshot())}
          revalidateReport={revalidateReport}
          openPublic={openPublic}
        />
      </I18nProvider>,
    );
    const preview = await preparePreview(user);

    await user.click(within(preview).getByRole("button", { name: "Open public GitHub form" }));
    expect(openPublic).toHaveBeenCalledOnce();
    expect(reserved.opener).toBeNull();
    await waitFor(() => expect(revalidateReport).toHaveBeenCalledOnce());
    expect(reserved.location.replace).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Title"), " changed");
    expect(reserved.close).toHaveBeenCalledOnce();
    resolveValidation?.({ outcome: "valid" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull(),
    );

    expect(reserved.location.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Complete sanitized report" })).toBeNull();
  });

  it("drops a deferred clipboard sink when optional removal invalidates the prepared digest", async () => {
    let resolveValidation: ((value: { readonly outcome: "valid" }) => void) | undefined;
    const pending = new Promise<{ readonly outcome: "valid" }>((resolve) => {
      resolveValidation = resolve;
    });
    const revalidateReport = vi.fn<FeedbackRevalidator>().mockReturnValue(pending);
    const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const { user } = renderFeedback(
      preparedSnapshotWithOptionalDispositions(),
      writeClipboard,
      revalidateReport,
    );
    const preview = await preparePreview(user);

    await user.click(within(preview).getByRole("button", { name: "Copy sanitized report" }));
    await waitFor(() => expect(revalidateReport).toHaveBeenCalledOnce());
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    await user.click(within(notices).getByRole("button", { name: "Remove browser description" }));
    resolveValidation?.({ outcome: "valid" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull(),
    );

    expect(writeClipboard).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Complete sanitized report" })).toBeNull();
  });

  it("closes a deferred blank reservation when optional removal invalidates the digest", async () => {
    let resolveValidation: ((value: { readonly outcome: "valid" }) => void) | undefined;
    const pending = new Promise<{ readonly outcome: "valid" }>((resolve) => {
      resolveValidation = resolve;
    });
    const revalidateReport = vi.fn<FeedbackRevalidator>().mockReturnValue(pending);
    const { user, reserved } = renderFeedback(
      preparedSnapshotWithOptionalDispositions(),
      vi.fn().mockResolvedValue(undefined),
      revalidateReport,
    );
    const preview = await preparePreview(user);

    await user.click(within(preview).getByRole("button", { name: "Open public GitHub form" }));
    await waitFor(() => expect(revalidateReport).toHaveBeenCalledOnce());
    const notices = within(preview).getByRole("region", { name: "Privacy changes" });
    await user.click(within(notices).getByRole("button", { name: "Remove browser description" }));

    expect(reserved.close).toHaveBeenCalledOnce();
    resolveValidation?.({ outcome: "valid" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull(),
    );
    expect(reserved.location.replace).not.toHaveBeenCalled();
  });
});
