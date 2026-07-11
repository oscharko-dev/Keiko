import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { describe, expect, it, vi } from "vitest";
import {
  createFeedbackSubmissionHttpPort,
  exactFeedbackIntakeOrigin,
} from "./feedback-submission-http.js";

function prepared(): PreparedFeedbackReportV1 {
  const result = prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title: "Safe",
    description: "Safe report",
    reproductionSteps: "Open Settings",
    expectedBehavior: "Works",
    actualBehavior: "Ready",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  });
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

describe("local feedback submission adapter", () => {
  it("is disabled unless configuration is one exact HTTPS origin", () => {
    for (const value of [
      undefined,
      "http://intake.example",
      "https://user@intake.example",
      "https://intake.example/path",
      "https://*.example",
    ])
      expect(exactFeedbackIntakeOrigin(value)).toBeUndefined();
    expect(exactFeedbackIntakeOrigin("https://intake.example:8443")).toBe(
      "https://intake.example:8443",
    );
  });

  it("posts byte-identical canonical JSON without credentials or redirects", async () => {
    const report = prepared();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          receiptId: "A".repeat(22),
          receiptSecret: "A".repeat(43),
          expiresAt: "2026-08-10T00:00:00.000Z",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    const port = createFeedbackSubmissionHttpPort({
      origin: "https://intake.example",
      timeoutMs: 2_000,
      fetch: fetcher,
    });
    await expect(port?.submit(report)).resolves.toMatchObject({ outcome: "accepted" });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit & { timeoutMs: number }];
    expect(url).toBe("https://intake.example/v1/feedback/reports");
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(report.canonicalJson);
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual", timeoutMs: 2_000 });
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Keiko-Feedback-Body-SHA256": report.exactBodySha256,
    });
  });

  it("maps hosted throttling to a closed-safe local outcome", async () => {
    const port = createFeedbackSubmissionHttpPort({
      origin: "https://intake.example",
      timeoutMs: 1,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "rate-limited", message: "Try again later." }), {
            status: 429,
            headers: { "Retry-After": "300" },
          }),
        ),
    });

    await expect(port?.submit(prepared())).resolves.toBe("rate-limited");
  });

  it("rejects redirects and malformed receipt responses", async () => {
    const redirected = createFeedbackSubmissionHttpPort({
      origin: "https://intake.example",
      timeoutMs: 1,
      fetch: () => Promise.resolve(new Response(null, { status: 302 })),
    });
    await expect(redirected?.submit(prepared())).rejects.toThrow("redirect");
    const malformed = createFeedbackSubmissionHttpPort({
      origin: "https://intake.example",
      timeoutMs: 1,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ receiptId: "leak" }), { status: 202 })),
    });
    await expect(malformed?.submit(prepared())).rejects.toThrow("receipt");
  });
});
