import { Blob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canonicalSupportJson,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { prepareLocalSupportReport } from "./support-report-local";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("URL", URL);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
