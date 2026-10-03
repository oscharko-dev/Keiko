import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportReport } from "./support-report-api";
import {
  fanOutClientDiagnostic,
  clientDiagnosticPostFailureCount,
  resetClientDiagnosticPostStateForTests,
} from "./install-client-diagnostics";

const correlationId = "browser-crash-evidence-01";
const report = {
  fileName: "keiko-support-v1-aabbccddeeff-2026-10-03.json",
  reportJson: '{"kind":"keiko.support.report"}',
};
const diagnostic = {
  kind: "window-error" as const,
  globalFailure: true,
  correlationId,
  errorEvidence: { errorClass: "TypeError" as const, frames: [], causeChain: [] },
};

function reportResponse(): Response {
  return new Response(JSON.stringify(report), { status: 200 });
}

afterEach(() => {
  resetClientDiagnosticPostStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser incident delivery before report selection", () => {
  it("waits for an in-flight delivery acknowledgement and does not post the error twice", async () => {
    let acknowledge: (response: Response) => void = () => undefined;
    const fetch = vi.fn().mockReturnValueOnce(
      new Promise<Response>((resolve): void => {
        acknowledge = resolve;
      }),
    );
    fetch.mockResolvedValueOnce(reportResponse());
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    const result = createSupportReport(correlationId);
    expect(fetch).toHaveBeenCalledOnce();
    acknowledge(new Response(null, { status: 204 }));
    expect(await result).toEqual(report);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/report",
    ]);
  });

  it("redelivers an offline browser failure under the same correlation before exporting", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline customer prose"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(reportResponse());
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    await vi.waitFor(() => expect(clientDiagnosticPostFailureCount()).toBe(1));
    expect(await createSupportReport(correlationId)).toEqual(report);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/client",
      "/api/diagnostics/report",
    ]);
    const retry = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as unknown;
    expect(retry).toMatchObject({ correlationId, errorEvidence: diagnostic.errorEvidence });
    expect(JSON.stringify(retry)).not.toContain("customer prose");
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toEqual({ correlationId });
  });

  it("redelivers a client-throttled boundary failure once through the bounded report budget", async () => {
    const fetch = vi.fn((path: string, _init: RequestInit): Promise<Response> =>
      Promise.resolve(
        path.endsWith("/report") ? reportResponse() : new Response(null, { status: 204 }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let index = 0; index < 20; index += 1) fanOutClientDiagnostic("bounded prior failure");
    fanOutClientDiagnostic("[keiko] window render failed: TypeError", {
      ...diagnostic,
      kind: "boundary",
      renderFailure: "window-body",
    });
    expect(fetch).toHaveBeenCalledTimes(20);
    await createSupportReport(correlationId);
    expect(fetch).toHaveBeenCalledTimes(22);
    expect(fetch.mock.calls.slice(-2).map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/report",
    ]);
    expect(JSON.parse(fetch.mock.calls[20]?.[1]?.body as string)).toMatchObject({
      correlationId,
      kind: "boundary",
      renderFailure: "window-body",
    });
  });

  it("keeps an undeliverable failure retryable without selecting an unrelated report", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    await vi.waitFor(() => expect(clientDiagnosticPostFailureCount()).toBe(1));
    await expect(createSupportReport(correlationId)).rejects.toThrow();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/client",
    ]);
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetch.mockResolvedValueOnce(reportResponse());
    expect(await createSupportReport(correlationId)).toEqual(report);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("bounds repeated manual redelivery while the server keeps refusing ingest", async () => {
    const fetch = vi.fn((_path: string, _init: RequestInit): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Limited" } }), {
          status: 429,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    await vi.waitFor(() => expect(clientDiagnosticPostFailureCount()).toBe(1));
    for (let index = 0; index < 8; index += 1)
      await expect(createSupportReport(correlationId)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.every(([path]) => path === "/api/diagnostics/client")).toBe(true);
  });

  it("cancels promptly while an original diagnostic is still in flight", async () => {
    const fetch = vi.fn((): Promise<Response> => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    const controller = new AbortController();
    const result = createSupportReport(correlationId, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("includes evidence delivery in the report deadline without selecting an orphan correlation", async () => {
    vi.useFakeTimers();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetch = vi.fn((): Promise<Response> => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    const result = createSupportReport(correlationId);
    const settled = expect(result).rejects.toMatchObject({
      name: "SupportReportEvidenceUnavailable",
    });
    deadline.abort(new DOMException("Expired", "TimeoutError"));
    await settled;
    expect(fetch).toHaveBeenCalledOnce();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(35_000);
  });
});
