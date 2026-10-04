import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportReport, createSupportReportDownload } from "./support-report-api";
import { bffFetchJson } from "./http";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";

const response = vi.hoisted(() => ({ value: {} as unknown }));
const pairing = vi.hoisted(() => ({ settled: Promise.resolve(true) }));
vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => pairing.settled,
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
  it("preserves the explicit client-only scope returned without launcher authority", async () => {
    pairing.settled = Promise.resolve(false);
    response.value = { fileName, reportJson: "{}", evidenceScope: "client-only" };
    await expect(createSupportReport("unpaired-report-id")).resolves.toEqual(response.value);
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
    await expect(createSupportReport()).rejects.toThrow(TypeError);
    response.value = { fileName };
    await expect(createSupportReport()).rejects.toThrow(TypeError);
  });

  it("bounds a report response by UTF-8 bytes before creating any download", async () => {
    response.value = { fileName, reportJson: "é".repeat(MAX_SUPPORT_REPORT_BYTES / 2 + 1) };
    await expect(createSupportReport()).rejects.toThrow(TypeError);
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
    await expect(createSupportReport()).rejects.toThrow(TypeError);
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
