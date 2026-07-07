import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeedbackIntakeItem,
  FeedbackIntakeReceipt,
  FeedbackReportDraft,
  FeedbackReportPreview,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import { I18nProvider } from "@/lib/i18n";
import { FeedbackWidget } from "./FeedbackWidget";

const previewFeedbackReportMock = vi.fn();
const submitFeedbackPreviewMock = vi.fn();
const fetchFeedbackIntakeQueueMock = vi.fn();
const reviewFeedbackIntakeItemMock = vi.fn();
const createFeedbackGithubIssueMock = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    public readonly code: string;
    public readonly status: number;

    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  },
  previewFeedbackReport: (draft: FeedbackReportDraft): Promise<FeedbackReportPreview> =>
    previewFeedbackReportMock(draft),
  submitFeedbackPreview: (
    preview: FeedbackReportPreview,
  ): Promise<{
    readonly receipt: FeedbackIntakeReceipt;
    readonly status: FeedbackIntakeReceipt["status"];
  }> => submitFeedbackPreviewMock(preview),
  fetchFeedbackIntakeQueue: (): Promise<{ readonly items: readonly FeedbackIntakeItem[] }> =>
    fetchFeedbackIntakeQueueMock(),
  reviewFeedbackIntakeItem: (...args: readonly unknown[]): Promise<unknown> =>
    reviewFeedbackIntakeItemMock(...args),
  createFeedbackGithubIssue: (...args: readonly unknown[]): Promise<unknown> =>
    createFeedbackGithubIssueMock(...args),
}));

function makePreview(): FeedbackReportPreview {
  return {
    schemaVersion: 1,
    report: {
      category: "bug",
      severity: "medium",
      title: "Crash after submit",
      description: "The token is [REDACTED].",
      reproductionSteps: ["Open form", "Submit"],
      diagnostics: {
        keikoVersion: "local-ui",
        platform: "test",
        uiMode: "desktop",
      },
    },
    provenance: {
      engine: "keiko-feedback-redaction",
      schemaVersion: 1,
      redactedFields: ["description"],
      omittedFields: [],
      blockedReasons: [],
    },
    payloadByteLength: 256,
    safeToSubmit: true,
  };
}

function renderWidget(): void {
  render(
    <I18nProvider>
      <FeedbackWidget />
    </I18nProvider>,
  );
}

describe("FeedbackWidget", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds a redacted preview and submits only that preview envelope", async () => {
    const user = userEvent.setup();
    const preview = makePreview();
    fetchFeedbackIntakeQueueMock.mockResolvedValue({ items: [] });
    previewFeedbackReportMock.mockResolvedValue(preview);
    submitFeedbackPreviewMock.mockResolvedValue({
      receipt: {
        schemaVersion: 1,
        intakeId: "fb_123",
        status: "new",
        dedupeKey: "dedupe",
        submittedAt: "2026-07-07T12:00:00.000Z",
      },
      status: "new",
    });

    renderWidget();

    await user.type(screen.getByLabelText("Title"), "Crash after submit");
    await user.type(screen.getByLabelText("Description"), "The token is sk-test-secret.");
    await user.type(screen.getByLabelText("Reproduction steps"), "Open form\nSubmit");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(previewFeedbackReportMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Redacted payload preview")).toBeTruthy();
    expect(screen.getByText(/\[REDACTED\]/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit Feedback" }));

    await waitFor(() => expect(submitFeedbackPreviewMock).toHaveBeenCalledWith(preview));
    expect(screen.getByText("Feedback submitted to intake: fb_123")).toBeTruthy();
  });

  it("offers the public GitHub issue fallback", () => {
    fetchFeedbackIntakeQueueMock.mockResolvedValue({ items: [] });
    renderWidget();

    const link = screen.getByRole("link", { name: "Public GitHub issue" });
    expect(link.getAttribute("href")).toBe("https://github.com/oscharko-dev/Keiko/issues/new");
  });

  it("reviews intake items before creating a GitHub issue", async () => {
    const user = userEvent.setup();
    const item: FeedbackIntakeItem = {
      schemaVersion: 1,
      receipt: {
        schemaVersion: 1,
        intakeId: "fb_review",
        status: "new",
        dedupeKey: "dedupe",
        submittedAt: "2026-07-07T12:00:00.000Z",
      },
      report: {
        category: "bug",
        severity: "medium",
        title: "Queue item",
        description: "Already redacted report.",
      },
      provenance: {
        engine: "keiko-feedback-redaction",
        schemaVersion: 1,
        redactedFields: [],
        omittedFields: [],
        blockedReasons: [],
      },
      review: { status: "new", events: [] },
    };
    const approved: FeedbackIntakeItem = {
      ...item,
      receipt: { ...item.receipt, status: "approved-for-github" },
      review: { status: "approved-for-github", events: [] },
    };
    const created: FeedbackIntakeItem = {
      ...approved,
      receipt: { ...approved.receipt, status: "github-created" },
      review: { status: "github-created", events: [] },
      githubIssue: {
        repository: "oscharko-dev/Keiko",
        number: 99,
        url: "https://github.com/oscharko-dev/Keiko/issues/99",
        createdAt: "2026-07-07T12:05:00.000Z",
      },
    };
    fetchFeedbackIntakeQueueMock.mockResolvedValue({ items: [item] });
    reviewFeedbackIntakeItemMock.mockResolvedValue(approved);
    createFeedbackGithubIssueMock.mockResolvedValue(created);

    renderWidget();

    expect(await screen.findByText("Queue item")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(reviewFeedbackIntakeItemMock).toHaveBeenCalledWith({
        intakeId: "fb_review",
        action: "approve-for-github",
        actor: "local-maintainer",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Create GitHub Issue" }));
    await waitFor(() => expect(createFeedbackGithubIssueMock).toHaveBeenCalledWith("fb_review"));
    expect(screen.getByRole("link", { name: "#99" }).getAttribute("href")).toBe(
      "https://github.com/oscharko-dev/Keiko/issues/99",
    );
  });
});
