import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupportReport,
  createSupportReportDownload,
  SupportReportResponseInvalid,
  SupportReportEvidenceUnavailable,
  supportReportAvailabilityReason,
} from "./support-report-api";
import { bffFetchJson } from "./http";
import { ApiError } from "./api";
import { canonicalSupportReportFixture } from "../test-utils/support-report-fixture";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";

const response = vi.hoisted(() => ({ value: {} as unknown }));
const pairing = vi.hoisted(() => ({
  settled: Promise.resolve(true),
  repair: vi.fn(() => Promise.resolve({ repaired: true, correlationId: "report-session-confirm" })),
}));
vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => pairing.settled,
  repairLocalCodingAppSessionWithEvidence: pairing.repair,
}));
vi.mock("./http", () => ({
  bffFetchJson: vi.fn(
    async (
      path: string,
      _init: RequestInit,
      options: { validator: (path: string, value: unknown) => unknown },
    ) => options.validator(path, response.value),
  ),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  pairing.settled = Promise.resolve(true);
});
const fileName = "keiko-support-v1-aabbccddeeff-2026-10-03.json";

describe("support report browser download", () => {
  it("confirms only existing session projections before selecting report evidence", async () => {
    let confirm: ((value: { repaired: boolean; correlationId: string }) => void) | undefined;
    pairing.repair.mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    response.value = { fileName, reportJson: "{}", evidenceScope: "client-only" };
    const result = createSupportReport("existing-session-report");
    await vi.waitFor(() => {
      expect(pairing.repair).toHaveBeenCalledOnce();
    });
    expect(bffFetchJson).not.toHaveBeenCalled();
    confirm?.({ repaired: false, correlationId: "report-session-confirm" });
    await expect(result).resolves.toEqual(response.value);
    expect(bffFetchJson).toHaveBeenCalledOnce();
  });

  it("does not post after cancellation during existing-session confirmation", async () => {
    let confirm: ((value: { repaired: boolean; correlationId: string }) => void) | undefined;
    pairing.repair.mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const controller = new AbortController();
    const result = createSupportReport("cancelled-session-report", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(pairing.repair).toHaveBeenCalledOnce();
    });
    controller.abort();
    confirm?.({ repaired: true, correlationId: "report-session-confirm" });
    await rejected;
    expect(bffFetchJson).not.toHaveBeenCalled();
  });

  it("preserves the validated canonical disposition for locally reused server evidence", async () => {
    const summary = {
      status: "degraded",
      reasons: ["context-truncated"],
      recordCount: 2,
      reportDigest: "a".repeat(64),
      incidentId: "b".repeat(32),
      manifestUnreadableCount: 0,
      manifestReusedCount: 1,
      completeness: "complete",
      loss: "none",
      pinDisposition: "pinned",
    };
    response.value = { fileName, reportJson: "{}", summary };
    expect((await createSupportReport()).summary).toEqual(summary);
    response.value = {
      fileName,
      reportJson: "{}",
      summary: { ...summary, loss: "private loss detail" },
    };
    await expect(createSupportReport()).rejects.toThrow("Invalid report summary");
  });
  it("preserves the explicit client-only scope returned without launcher authority", async () => {
    pairing.settled = Promise.resolve(false);
    response.value = { fileName, reportJson: "{}", evidenceScope: "client-only" };
    await expect(createSupportReport("unpaired-report-id")).resolves.toEqual(response.value);
  });
  it("forwards only the original closed cause through the same bounded report request", async () => {
    response.value = { fileName, reportJson: "{}", evidenceScope: "client-only" };
    const failure = {
      errorKind: "unavailable" as const,
      context: ["kind:sse-error"],
      errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
    };
    await createSupportReport("unpaired-cause", undefined, failure);
    const body = vi.mocked(bffFetchJson).mock.calls.at(-1)?.[1]?.body;
    expect(body).toBe(JSON.stringify({ correlationId: "unpaired-cause", failure }));
    expect(new TextEncoder().encode(String(body)).byteLength).toBeLessThanOrEqual(1024);
  });

  it("omits oversized optional frames without inventing an empty observed stack", async () => {
    response.value = { fileName, reportJson: "{}", evidenceScope: "client-only" };
    const failure = {
      errorKind: "timeout" as const,
      context: [
        "kind:sse-error",
        "render:window-body",
        "module:git-history",
        "stage:files-directory-navigation",
      ],
      errorEvidence: {
        errorClass: "ApiError",
        frames: Array.from(
          { length: 8 },
          () => `dist/ui/static/_next/static/chunks/${"a".repeat(32)}.js:12345678:12345678`,
        ),
        causeChain: ["Error"],
      },
    };
    expect(
      new TextEncoder().encode(JSON.stringify({ correlationId: "b".repeat(128), failure }))
        .byteLength,
    ).toBeGreaterThan(1030);
    await createSupportReport("b".repeat(128), undefined, failure);
    const body = vi.mocked(bffFetchJson).mock.calls.at(-1)?.[1]?.body;
    expect(body).toBe(
      JSON.stringify({
        correlationId: "b".repeat(128),
        failure: { errorKind: failure.errorKind, context: failure.context },
      }),
    );
    expect(new TextEncoder().encode(String(body)).byteLength).toBeLessThanOrEqual(1024);
    expect(String(body)).not.toContain("frames");
  });

  it("rejects an unknown evidence scope rather than claiming a complete report", async () => {
    response.value = { fileName, reportJson: "{}", evidenceScope: "private-log-bypass" };
    await expect(createSupportReport()).rejects.toThrow("Invalid report evidence scope");
  });

  it("waits for boot pairing before the protected report request", async () => {
    let completePairing: (value: boolean) => void = () => undefined;
    pairing.settled = new Promise((resolve) => {
      completePairing = resolve;
    });
    response.value = { fileName, reportJson: "{}" };
    const pending = createSupportReport("boot-failure");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(bffFetchJson).not.toHaveBeenCalled();
    completePairing(true);
    await expect(pending).resolves.toEqual(response.value);
    expect(bffFetchJson).toHaveBeenCalledOnce();
  });

  it("preserves timeout before boot pairing settles without posting an orphan report", async () => {
    let completePairing: (value: boolean) => void = () => undefined;
    pairing.settled = new Promise((resolve) => {
      completePairing = resolve;
    });
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const pending = createSupportReport("pre-pairing-failure");
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    deadline.abort(new DOMException("Expired", "TimeoutError"));
    completePairing(false);
    await rejected;
    expect(bffFetchJson).not.toHaveBeenCalled();
  });

  it("accepts the closed canonical filename and preserves report bytes", async () => {
    response.value = { fileName, reportJson: '{"kind":"keiko.support.report"}' };
    expect(await createSupportReport("failure-1")).toEqual(response.value);
  });

  it("rejects a response with an unsafe filename or missing report", async () => {
    response.value = { fileName: "../../private.json", reportJson: "{}" };
    await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
    response.value = { fileName };
    await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
  });

  it("bounds a report response by UTF-8 bytes before creating any download", async () => {
    response.value = { fileName, reportJson: "é".repeat(MAX_SUPPORT_REPORT_BYTES / 2 + 1) };
    await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
  });

  it("propagates cancellation through the bounded report request", async () => {
    response.value = { fileName, reportJson: "{}" };
    const controller = new AbortController();
    await createSupportReport("failure-cancelled", controller.signal);
    const signal = vi.mocked(bffFetchJson).mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("uses the same-origin authenticated HTTP attachment when supplied", async () => {
    const downloadPath = "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    response.value = {
      fileName,
      reportJson: "{}",
      downloadPath,
      downloadExpiresAtMs: Date.now() + 60_000,
    };
    const report = await createSupportReport();
    expect(report).toEqual(response.value);
    const target = createSupportReportDownload(report);
    expect(target.href).toBe(downloadPath);
    expect(target.fileName).toBe(`${fileName}.gz`);
    target.dispose();
  });

  it.each([
    "https://other.invalid/report",
    "//other.invalid/report",
    "/api/files/private",
    "/api/diagnostics/report/download/../private",
  ])("rejects unsafe HTTP attachment target %s", async (downloadPath) => {
    response.value = {
      fileName,
      reportJson: "{}",
      downloadPath,
      downloadExpiresAtMs: Date.now() + 60_000,
    };
    await expect(createSupportReport()).rejects.toBeInstanceOf(SupportReportResponseInvalid);
  });

  it("keeps a real download target stable until the cache explicitly releases it", () => {
    const objectUrl = vi.fn(() => "blob:persistent-report");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = objectUrl;
        static override revokeObjectURL = revoke;
      },
    );
    try {
      const target = createSupportReportDownload({ fileName, reportJson: "{}" });
      expect(target.href).toBe("blob:persistent-report");
      expect(revoke).not.toHaveBeenCalled();
      target.dispose();
      expect(revoke).toHaveBeenCalledExactlyOnceWith(target.href);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it.each([
  { name: "missing", expiry: undefined },
  { name: "expired", expiry: 0 },
  { name: "current instant", expiry: "now" },
  { name: "non-integer", expiry: "fractional future" },
  { name: "unsafe integer", expiry: Number.MAX_SAFE_INTEGER + 1 },
])("rejects a canonical response with $name HTTP target expiry", async ({ expiry }) => {
  const canonical = await canonicalSupportReportFixture();
  let observedExpiry = expiry;
  if (observedExpiry === "now") observedExpiry = Date.now();
  if (observedExpiry === "fractional future") observedExpiry = Date.now() + 60_000.5;
  response.value = {
    ...canonical,
    downloadPath: "/api/diagnostics/report/download/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...(observedExpiry === undefined ? {} : { downloadExpiresAtMs: observedExpiry }),
  };
  await expect(createSupportReport()).rejects.toThrow("Invalid support report download target");
});

it("preserves the actual malformed-response request correlation using the shared HTTP validation convention", async () => {
  const realHttp = await vi.importActual<typeof import("./http")>("./http");
  vi.mocked(bffFetchJson).mockImplementationOnce(realHttp.bffFetchJson);
  const canonical = await canonicalSupportReportFixture();
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ...canonical,
        evidenceScope: "unsupported",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Keiko-Correlation-Id": "report-request-malformed-body",
        },
      },
    ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  try {
    await expect(createSupportReport()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
      correlationId: "report-request-malformed-body",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("closed support report availability causes", () => {
  it.each([
    [new SupportReportEvidenceUnavailable(), "diagnostic-delivery-unavailable"],
    [
      new ApiError("SUPPORT_REPORT_SELECTION_UNAVAILABLE", "Unavailable", 503),
      "diagnostic-delivery-unavailable",
    ],
    [
      new ApiError("SUPPORT_REPORT_UNAVAILABLE", "selection-unavailable", 503),
      "service-unavailable",
    ],
    [new TypeError("SUPPORT_REPORT_SELECTION_UNAVAILABLE"), "service-unavailable"],
    [{ code: "SUPPORT_REPORT_SELECTION_UNAVAILABLE" }, "service-unavailable"],
  ] as const)("maps only validated closed causes ($1)", (error, reason) => {
    expect(supportReportAvailabilityReason(error)).toBe(reason);
  });
});
