import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  FeedbackSecurityRoutingError,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import { I18nProvider } from "@/lib/i18n";

import { FeedbackWindow } from "./FeedbackWindow";
import type { FeedbackPublicOpener } from "./FeedbackPublicHandoff";
import type { FeedbackReservedWindow } from "./feedback-public-window";
import { preparedSnapshot } from "./FeedbackWindow.test-helpers";

const SECURITY_URL = "https://github.com/oscharko-dev/Keiko/security/advisories/new";

function reservedWindow() {
  return {
    opener: {} as unknown,
    close: vi.fn<() => void>(),
    document: document.implementation.createHTMLDocument(),
    location: { replace: vi.fn<(url: string) => void>() },
  } satisfies FeedbackReservedWindow;
}

async function prepare(
  user: ReturnType<typeof userEvent.setup>,
  title = "Ordinary feedback",
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Continue with ordinary feedback" }));
  await user.type(screen.getByLabelText("Product version"), "0.2.14");
  await user.type(screen.getByLabelText("Title"), title);
  await user.type(screen.getByLabelText("Description"), "The ordinary flow is blocked.");
  await user.type(screen.getByLabelText("Steps to reproduce"), "Open Settings.");
  await user.type(screen.getByLabelText("Expected result"), "The flow continues.");
  await user.type(screen.getByLabelText("Actual result"), "The flow stopped.");
  await user.click(screen.getByRole("button", { name: "Scan and preview" }));
}

function previewMock(snapshot: PreparedFeedbackSnapshotV1 = preparedSnapshot()) {
  return vi
    .fn<(draft: FeedbackBrowserDraftV1) => Promise<PreparedFeedbackSnapshotV1>>()
    .mockResolvedValue(snapshot);
}

describe("FeedbackWindow security boundaries", () => {
  it("blocks a detected security report and repeats the fixed private route", async () => {
    const user = userEvent.setup();
    const previewReport = previewMock().mockRejectedValue(new FeedbackSecurityRoutingError());
    render(
      <I18nProvider>
        <FeedbackWindow previewReport={previewReport} />
      </I18nProvider>,
    );

    await prepare(user, "Security vulnerability: authentication bypass");
    const alert = await screen.findByRole("alert");

    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent("Ordinary submission and public sharing are blocked");
    expect(
      within(alert).getByRole("link", { name: "Report a security issue privately" }),
    ).toHaveAttribute("href", SECURITY_URL);
    expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open public GitHub form" })).toBeNull();
    expect(screen.queryByRole("button", { name: /send anyway/iu })).toBeNull();
  });

  it.each(["rejected", "security"] as const)(
    "invalidates approval and exposes no public payload after %s revalidation",
    async (outcome) => {
      const user = userEvent.setup();
      const snapshot = preparedSnapshot();
      const revalidateReport = vi.fn().mockResolvedValue({ outcome });
      const writeClipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
      render(
        <I18nProvider>
          <FeedbackWindow
            previewReport={previewMock(snapshot)}
            revalidateReport={revalidateReport}
            writeClipboard={writeClipboard}
          />
        </I18nProvider>,
      );

      await prepare(user);
      const preview = await screen.findByRole("region", { name: "Sanitized preview" });
      await user.click(
        within(preview).getByRole("checkbox", {
          name: "I reviewed the exact sanitized payload and confirm it is ready for submission.",
        }),
      );
      expect(
        within(preview).queryByRole("textbox", { name: "Complete sanitized report" }),
      ).toBeNull();
      await user.click(within(preview).getByRole("button", { name: "Copy sanitized report" }));

      await waitFor(() => expect(revalidateReport).toHaveBeenCalledExactlyOnceWith(snapshot));
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Sanitized preview" })).toBeNull(),
      );
      expect(writeClipboard).not.toHaveBeenCalled();
      expect(screen.queryByText(snapshot.report.summary.description)).toBeNull();
      if (outcome === "security") {
        expect(screen.getByRole("alert")).toHaveTextContent("public sharing are blocked");
        expect(
          screen.getAllByRole("link", { name: "Report a security issue privately" }),
        ).toHaveLength(2);
      } else {
        expect(screen.getByRole("alert")).toHaveTextContent("Edit it and scan again");
      }
    },
  );

  it("does not navigate or expose the projection when live revalidation is unavailable", async () => {
    const user = userEvent.setup();
    const revalidateReport = vi.fn().mockRejectedValue(new Error("private failure"));
    const reserved = reservedWindow();
    const openPublic = vi.fn<FeedbackPublicOpener>().mockReturnValue(reserved);
    render(
      <I18nProvider>
        <FeedbackWindow
          previewReport={previewMock()}
          revalidateReport={revalidateReport}
          openPublic={openPublic}
        />
      </I18nProvider>,
    );

    await prepare(user);
    const preview = await screen.findByRole("region", { name: "Sanitized preview" });
    await user.click(within(preview).getByRole("button", { name: "Open public GitHub form" }));

    const alert = await within(preview).findByRole("alert");
    expect(alert).toHaveTextContent("No public payload was opened or copied");
    expect(openPublic).toHaveBeenCalledOnce();
    expect(reserved.opener).toBeNull();
    expect(reserved.close).toHaveBeenCalledOnce();
    expect(reserved.location.replace).not.toHaveBeenCalled();
    expect(
      within(preview).queryByRole("textbox", { name: "Complete sanitized report" }),
    ).toBeNull();
  });
});
