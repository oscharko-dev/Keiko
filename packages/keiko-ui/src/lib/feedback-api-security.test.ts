import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeedbackApiError,
  FeedbackSecurityRoutingError,
  previewFeedbackReportV1,
  revalidateFeedbackReportV1,
  type FeedbackBrowserDraftV1,
} from "./feedback-api";

const PREPARED = {
  canonicalJson: "{}",
  exactBodySha256: "0".repeat(64),
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function draft(): FeedbackBrowserDraftV1 {
  return {
    schemaVersion: "1",
    category: "defect",
    title: "Security vulnerability: authentication bypass",
    description: "A crafted session bypasses login.",
    reproductionSteps: "Open the login window.",
    expectedBehavior: "The session should be rejected.",
    actualBehavior: "The session was accepted.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Blocks core workflow",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("feedback browser security boundary", () => {
  it("recognizes only the closed private-security preview response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "FEEDBACK_SECURITY_REPORT",
              message: "Use the private security reporting route.",
            },
          },
          422,
        ),
      ),
    );

    await expect(previewFeedbackReportV1(draft())).rejects.toBeInstanceOf(
      FeedbackSecurityRoutingError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "FEEDBACK_SECURITY_REPORT",
              message: "Use the private security reporting route.",
              excerpt: "private exploit",
            },
          },
          422,
        ),
      ),
    );
    await expect(previewFeedbackReportV1(draft())).rejects.toEqual(expect.any(FeedbackApiError));
    await expect(previewFeedbackReportV1(draft())).rejects.not.toBeInstanceOf(
      FeedbackSecurityRoutingError,
    );
  });

  it.each(["valid", "rejected", "security"] as const)(
    "revalidates only the exact canonical pair and closed %s outcome",
    async (outcome) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ outcome }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(revalidateFeedbackReportV1(PREPARED)).resolves.toEqual({ outcome });
      const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe("/api/feedback/revalidate");
      expect(JSON.parse(init.body as string)).toEqual(PREPARED);
    },
  );

  it("rejects extra revalidation response fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ outcome: "valid", canonicalJson: "private" })),
    );

    await expect(revalidateFeedbackReportV1(PREPARED)).rejects.toBeInstanceOf(FeedbackApiError);
  });
});
