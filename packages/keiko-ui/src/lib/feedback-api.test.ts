import { createHash, webcrypto } from "node:crypto";

import type {
  FeedbackDispositionRecordV1,
  FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeedbackApiError,
  FeedbackPreviewPreparationError,
  previewFeedbackReportV1,
  submitFeedbackReportV1,
  type FeedbackBrowserDraftV1,
} from "./feedback-api";

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`)
    .join(",")}}`;
}

function report(): FeedbackReportV1 {
  return {
    schemaVersion: "1",
    privacyContractVersion: "1",
    redactionProvenance: {
      engineVersion: "1",
      rules: [{ code: "credential-assignment", count: 1 }],
    },
    productVersion: "0.2.14",
    platform: "Linux",
    summary: { title: "Bearer", description: "The login button remained disabled" },
    steps: "Open Settings and select Continue.",
    expectedResult: "The login flow continues.",
    actualResult: "The login button remained disabled.",
    impact: "Degrades core workflow",
    diagnostics: { category: "defect", featureArea: "model-configuration" },
  };
}

function draft(): FeedbackBrowserDraftV1 {
  return {
    schemaVersion: "1",
    category: "defect",
    title: "Bearer",
    description: "The login button remained disabled",
    reproductionSteps: "Open Settings and select Continue.",
    expectedBehavior: "The login flow continues.",
    actualBehavior: "The login button remained disabled.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

function preparedResponse(): Record<string, unknown> {
  const preparedReport = report();
  const canonicalJson = canonicalise(preparedReport);
  const exactBodySha256 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  const record: FeedbackDispositionRecordV1 = {
    action: "redacted",
    reason: "complete-sensitive-span",
    unitKind: "structured-value",
    target: { kind: "draft-field", field: "actualBehavior" },
  };
  return {
    report: preparedReport,
    canonicalJson,
    exactBodySha256,
    dispositionSidecar: { exactBodySha256, records: [record] },
  };
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function expectGenericFeedbackApiError(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackApiError);
    expect(error).not.toBeInstanceOf(FeedbackPreviewPreparationError);
    expect((error as FeedbackApiError).message).toBe("The feedback response failed validation.");
    return;
  }
  expect.fail("Expected the feedback API request to reject.");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feedback browser API", () => {
  it("validates and freezes preview bytes before submitting only the canonical pair", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(preparedResponse()))
      .mockResolvedValueOnce(jsonOk({ outcome: "accepted" }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await previewFeedbackReportV1(draft());
    const outcome = await submitFeedbackReportV1(prepared);

    expect(prepared.report.summary).toEqual({
      title: "Bearer",
      description: "The login button remained disabled",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.report.summary)).toBe(true);
    expect(Object.isFrozen(prepared.dispositionSidecar.records)).toBe(true);
    expect(outcome).toEqual({ outcome: "accepted" });

    const [previewPath, previewInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(previewPath).toBe("/api/feedback/preview");
    expect(previewInit.method).toBe("POST");
    expect(previewInit.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    });
    expect(JSON.parse(previewInit.body as string)).toMatchObject({
      title: "Bearer",
      description: "The login button remained disabled",
    });

    const [submitPath, submitInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(submitPath).toBe("/api/feedback/submit");
    expect(Object.keys(JSON.parse(submitInit.body as string)).sort()).toEqual([
      "canonicalJson",
      "exactBodySha256",
    ]);
  });

  it("rejects extra raw response fields and every report, digest, or sidecar mismatch", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const sentinel = "raw-response-sentinel";
    const base = preparedResponse();
    const baseReport = base.report as FeedbackReportV1;
    const sidecar = base.dispositionSidecar as {
      readonly exactBodySha256: string;
      readonly records: readonly FeedbackDispositionRecordV1[];
    };
    const noncanonicalJson = JSON.stringify(baseReport);
    const noncanonicalDigest = createHash("sha256").update(noncanonicalJson, "utf8").digest("hex");
    const invalidResponses: readonly unknown[] = [
      { ...base, rawDraft: sentinel },
      {
        ...base,
        report: {
          ...baseReport,
          summary: { ...baseReport.summary, title: "Server report drift" },
        },
      },
      {
        ...base,
        exactBodySha256: "0".repeat(64),
        dispositionSidecar: { ...sidecar, exactBodySha256: "0".repeat(64) },
      },
      {
        ...base,
        canonicalJson: noncanonicalJson,
        exactBodySha256: noncanonicalDigest,
        dispositionSidecar: { ...sidecar, exactBodySha256: noncanonicalDigest },
      },
      {
        ...base,
        dispositionSidecar: {
          ...sidecar,
          records: [{ ...sidecar.records[0], action: "send-anyway" }],
        },
      },
      {
        ...base,
        dispositionSidecar: {
          ...sidecar,
          records: [{ ...sidecar.records[0], excerpt: sentinel }],
        },
      },
      {
        ...base,
        dispositionSidecar: {
          ...sidecar,
          records: [{ ...sidecar.records[0], reason: "raw-secret-reason" }],
        },
      },
      {
        ...base,
        dispositionSidecar: {
          ...sidecar,
          records: [
            {
              ...sidecar.records[0],
              target: { kind: "draft-field", field: "unknown-field" },
            },
          ],
        },
      },
    ];

    for (const response of invalidResponses) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(response)));
      await expectGenericFeedbackApiError(previewFeedbackReportV1(draft()));
    }
  });

  it("accepts only the closed local submit outcome", async () => {
    for (const response of [
      { outcome: "accepted", receiptSecret: "must-not-enter-ui-contract" },
      { outcome: "queued" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(response)));
      await expectGenericFeedbackApiError(
        submitFeedbackReportV1({ canonicalJson: "{}", exactBodySha256: "0".repeat(64) }),
      );
    }
  });

  it("treats a non-success submit response as an uncertain content-free failure", async () => {
    const privateFailure = "private-port-failure-must-stay-hidden";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk(
          {
            error: {
              code: "FEEDBACK_SUBMIT_FAILED",
              message: privateFailure,
            },
          },
          502,
        ),
      ),
    );

    await expectGenericFeedbackApiError(
      submitFeedbackReportV1({ canonicalJson: "{}", exactBodySha256: "0".repeat(64) }),
    );
  });

  it("returns only validated content-free preparation errors for recovery", async () => {
    const response = {
      error: {
        code: "FEEDBACK_PREVIEW_REJECTED",
        message: "The feedback draft needs attention.",
      },
      errors: [
        {
          code: "rewrite-required",
          target: { kind: "draft-field", field: "description" },
        },
        { code: "binary-signature", field: "attachments" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(response, 422)));

    let caught: unknown;
    try {
      await previewFeedbackReportV1(draft());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FeedbackPreviewPreparationError);
    expect(caught).toMatchObject({ errors: response.errors });
    const preparation = caught as FeedbackPreviewPreparationError;
    expect(Object.isFrozen(preparation.errors)).toBe(true);
    expect(Object.isFrozen(preparation.errors[0])).toBe(true);
  });

  it("collapses malformed, extra, raw, fetch, and JSON failures to a generic error", async () => {
    const sentinel = "raw-error-sentinel";
    const baseError = {
      error: {
        code: "FEEDBACK_PREVIEW_REJECTED",
        message: "The feedback draft needs attention.",
      },
      errors: [{ code: "rewrite-required", target: { kind: "draft-field", field: "title" } }],
    };
    const malformed: readonly unknown[] = [
      { ...baseError, rawDraft: sentinel },
      { ...baseError, error: { ...baseError.error, excerpt: sentinel } },
      {
        ...baseError,
        errors: [{ ...baseError.errors[0], excerpt: sentinel }],
      },
      {
        ...baseError,
        errors: [{ code: "rewrite-required", target: { kind: "draft-field", field: "unknown" } }],
      },
      { ...baseError, errors: [{ code: "unknown-code", field: "report" }] },
    ];

    for (const response of malformed) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(response, 422)));
      await expectGenericFeedbackApiError(previewFeedbackReportV1(draft()));
    }

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(sentinel)));
    await expectGenericFeedbackApiError(previewFeedbackReportV1(draft()));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(sentinel, { status: 422, headers: { "Content-Type": "application/json" } }),
        ),
    );
    await expectGenericFeedbackApiError(previewFeedbackReportV1(draft()));
  });

  it("serializes only the bounded browser attachment envelope", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(preparedResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const attachment = {
      bytesBase64: "U2FmZSBhdHRhY2htZW50",
      declaredMediaType: "text/plain",
      extension: ".txt",
    };

    await previewFeedbackReportV1({ ...draft(), attachments: [attachment] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const serialized = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(serialized.attachments).toEqual([attachment]);
    expect(JSON.stringify(serialized)).not.toContain("filename");
    expect(JSON.stringify(serialized)).not.toContain("path");
  });
});
