import { Blob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canonicalSupportJson,
  type SupportReport,
  type ClientOnlySupportReportInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { prepareLocalSupportReport, prepareCachedSupportReport } from "./support-report-local";
import { setClientDiagnosticDeliveryRetry, takeClientDiagnosticLoss } from "./client-diagnostics";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("URL", URL);
  takeClientDiagnosticLoss();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setClientDiagnosticDeliveryRetry(async () => undefined);
  takeClientDiagnosticLoss();
});

it("prepares exact canonical bytes with verified digests and standard gzip without a server", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const prepared = await prepareLocalSupportReport(new AbortController().signal);
  try {
    const response = await fetch(prepared.download.href);
    const transport = Buffer.from(await response.arrayBuffer());
    const text = gunzipSync(transport, { maxOutputLength: 10 * 1024 * 1024 }).toString("utf8");
    expect(text).toBe(prepared.report.reportJson);
    const report = JSON.parse(text) as SupportReport;
    expect(text).toBe(`${canonicalSupportJson(report)}\n`);
    const sha = (value: unknown): string =>
      createHash("sha256").update(canonicalSupportJson(value)).digest("hex");
    expect(report.integrity.incidentDigest).toBe(sha(report.incident));
    expect(report.integrity.selectionDigest).toBe(sha(report.selection));
    expect(report.integrity.evidenceDigest).toBe(sha(report.evidence));
    const { reportDigest, ...integrity } = report.integrity;
    expect(reportDigest).toBe(sha({ ...report, integrity }));
    expect(report.evidence.recordCount).toBe(0);
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
    expect(report.incident.clientReport?.availabilityReason).toBe("service-unavailable");
    expect(prepared.download.fileName).toBe(`${prepared.report.fileName}.gz`);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(prepared.download.href);
  } finally {
    prepared.download.dispose();
  }
  await expect(fetch(prepared.download.href)).rejects.toThrow();
});

it("does not produce a download after caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const objectUrl = vi.spyOn(URL, "createObjectURL");
  await expect(prepareLocalSupportReport(controller.signal)).rejects.toThrow();
  expect(objectUrl).not.toHaveBeenCalled();
});

it("rejects a cancelled digest completion before constructing a download URL", async () => {
  const controller = new AbortController();
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const result = await nativeDigest(...args);
    controller.abort();
    return result;
  });
  const objectUrl = vi.spyOn(URL, "createObjectURL");
  await expect(prepareLocalSupportReport(controller.signal)).rejects.toThrow();
  expect(objectUrl).not.toHaveBeenCalled();
});

it("retains the original support ID and closed failure facts without private error text", async () => {
  const prepared = await prepareLocalSupportReport(new AbortController().signal, {
    correlationId: "failed-request-original-123",
    failure: {
      errorKind: "permission-denied",
      errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
      context: ["stage:files-directory-load"],
    },
  });
  try {
    const report = JSON.parse(prepared.report.reportJson) as SupportReport;
    expect(report.incident.correlation.rootCorrelationId).toBe("failed-request-original-123");
    expect(report.incident.clientReport?.failure).toEqual({
      errorKind: "permission-denied",
      errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
      context: ["stage:files-directory-load"],
    });
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
    expect(report.evidence.recordCount).toBe(0);
  } finally {
    prepared.download.dispose();
  }
});

it("projects canonical header completeness and loss without a second report encoding", async () => {
  const prepared = await prepareLocalSupportReport(new AbortController().signal);
  const report = JSON.parse(prepared.report.reportJson) as SupportReport;
  expect(prepared.report.summary?.completeness).toBe(report.incident.completeness);
  expect(prepared.report.summary?.loss).toBe(report.incident.loss);
  expect(prepared.report.summary?.availabilityReason).toBe(
    report.incident.clientReport?.availabilityReason,
  );
  prepared.download.dispose();
});

it("still prepares canonical limited evidence when an original notice has a malformed correlation", async () => {
  const prepared = await prepareLocalSupportReport(new AbortController().signal, {
    correlationId: "abc",
    failure: { errorKind: "permission-denied", context: ["stage:files-directory-load"] },
  });
  try {
    const report = JSON.parse(prepared.report.reportJson) as SupportReport;
    expect(report.incident.correlation.rootCorrelationId).toBe("id000001");
    expect(report.incident.clientReport?.failure?.errorKind).toBe("permission-denied");
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
    expect(report.evidence.recordCount).toBe(0);
  } finally {
    prepared.download.dispose();
  }
});

const suppliedFailure: NonNullable<ClientOnlySupportReportInput["failure"]> = {
  errorKind: "permission-denied",
  context: ["stage:files-directory-load"],
  errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
};
const retainedFailure: NonNullable<ClientOnlySupportReportInput["failure"]> = {
  errorKind: "unavailable",
  context: ["kind:sse-error"],
  errorEvidence: { errorClass: "Error", frames: [], causeChain: [] },
};
it.each([
  {
    name: "unknown retained kind and empty context use supplied facts",
    retained: { errorKind: "unknown" as const, context: [] },
    expected: suppliedFailure,
  },
  {
    name: "precise retained facts and retained evidence win",
    retained: retainedFailure,
    expected: retainedFailure,
  },
  {
    name: "absent retained failure keeps supplied facts",
    retained: undefined,
    expected: suppliedFailure,
  },
])("preserves actual canonical failure precedence: $name", async ({ retained, expected }) => {
  const lookup = vi.fn(() => retained);
  setClientDiagnosticDeliveryRetry(async () => undefined, lookup);
  const prepared = await prepareLocalSupportReport(new AbortController().signal, {
    correlationId: "retained-original-cause",
    failure: suppliedFailure,
  });
  try {
    const report = JSON.parse(prepared.report.reportJson) as SupportReport;
    expect(report.incident.clientReport?.failure).toEqual(expected);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("retained-original-cause");
  } finally {
    prepared.download.dispose();
  }
});

it("omits rejected client facets while recording body-free suppression and preserving a canonical download", async () => {
  const prepared = await prepareLocalSupportReport(new AbortController().signal, {
    correlationId: "safe-original-id",
    failure: { errorKind: "internal", context: ["private-customer-prose"] },
  });
  try {
    const report = JSON.parse(prepared.report.reportJson) as SupportReport;
    expect(report.incident.correlation.rootCorrelationId).toBe("safe-original-id");
    expect(report.incident.clientReport?.failure).toBeUndefined();
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
    expect(prepared.report.reportJson).not.toContain("private-customer-prose");
    expect(takeClientDiagnosticLoss()?.errorsSuppressed).toBe(1);
  } finally {
    prepared.download.dispose();
  }
});

it("does not declare transport loss for absent optional supplied and retained failure facts", async () => {
  setClientDiagnosticDeliveryRetry(
    async () => undefined,
    () => undefined,
  );
  const prepared = await prepareLocalSupportReport(new AbortController().signal, {
    correlationId: "ordinary-manual-report",
  });
  try {
    const report = JSON.parse(prepared.report.reportJson) as SupportReport;
    expect(report.incident.clientReport?.failure).toBeUndefined();
    expect(takeClientDiagnosticLoss()).toBeUndefined();
  } finally {
    prepared.download.dispose();
  }
});

it.each([
  "session-unavailable",
  "diagnostic-delivery-unavailable",
  "service-unavailable",
  "client-only-selected",
  "correlation-unavailable",
] as const)(
  "seals the observed availability reason and preserves it through cached download retry: %s",
  async (availabilityReason) => {
    const context = { correlationId: "original-availability-cause", availabilityReason };
    const prepared = await prepareLocalSupportReport(new AbortController().signal, context);
    try {
      const report = JSON.parse(prepared.report.reportJson) as SupportReport;
      expect(report.incident.clientReport?.availabilityReason).toBe(availabilityReason);
      expect(prepared.report.summary?.availabilityReason).toBe(availabilityReason);
      expect(report.evidence.recordCount).toBe(0);
      expect(report.incident.sufficiencyStatus).toBe("insufficient");
      const retry = await prepareCachedSupportReport(prepared.report, new AbortController().signal);
      try {
        const downloaded = Buffer.from(await (await fetch(retry.download.href)).arrayBuffer());
        expect(gunzipSync(downloaded).toString("utf8")).toBe(prepared.report.reportJson);
        expect(retry.report).toBe(prepared.report);
      } finally {
        retry.download.dispose();
      }
    } finally {
      prepared.download.dispose();
    }
  },
);
