import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportReport } from "./support-report-api";
import { clientErrorEvidence } from "./client-error-evidence";
import { observeFilesDirectoryRead } from "./files-navigation-evidence";
import { bffRequestErrorKind } from "./http";
import * as clientDiagnostics from "./client-diagnostics";
import {
  fanOutClientDiagnostic,
  clientDiagnosticPostFailureCount,
  resetClientDiagnosticPostStateForTests,
} from "./install-client-diagnostics";

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
}));

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

  it.each(["Editor file load", "Files directory read", "File preview read"])(
    "redelivers an offline %s failure without browser-global metadata",
    async (surface) => {
      const failure = new TypeError("offline customer prose");
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(reportResponse());
      vi.stubGlobal("fetch", fetch);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fanOutClientDiagnostic(`${surface} failed: TypeError`, {
        correlationId,
        errorKind: bffRequestErrorKind(failure),
        errorEvidence: clientErrorEvidence(failure),
      });
      await vi.waitFor(() => expect(clientDiagnosticPostFailureCount()).toBe(1));
      expect(await createSupportReport(correlationId)).toEqual(report);
      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        "/api/diagnostics/client",
        "/api/diagnostics/client",
        "/api/diagnostics/report",
      ]);
      const replay = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string) as unknown;
      expect(replay).toMatchObject({
        correlationId,
        errorKind: "unavailable",
        errorEvidence: {
          errorClass: "TypeError",
          frames: [],
          causeChain: [],
        },
      });
      expect(JSON.stringify(replay)).not.toContain("customer prose");
      expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toEqual({ correlationId });
    },
  );

  it("replays the actual Files read failure after the client diagnostic budget was exhausted", async () => {
    const fetch = vi.fn((path: string, _init: RequestInit): Promise<Response> =>
      Promise.resolve(
        path.endsWith("/report") ? reportResponse() : new Response(null, { status: 204 }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    clientDiagnostics.setClientDiagnosticWriter(fanOutClientDiagnostic);
    for (let index = 0; index < 20; index += 1) fanOutClientDiagnostic("bounded prior failure");
    await expect(
      observeFilesDirectoryRead(
        (): Promise<never> => Promise.reject(new TypeError("customer path and content")),
        { correlationId, settle: (): void => undefined },
      ),
    ).rejects.toThrow("Workspace directory read failed");
    const beforeReport = fetch.mock.calls.length;
    expect(await createSupportReport(correlationId)).toEqual(report);
    expect(fetch.mock.calls.slice(beforeReport).map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/report",
    ]);
    const replay = JSON.parse(fetch.mock.calls[beforeReport]?.[1]?.body as string) as unknown;
    expect(replay).toMatchObject({ correlationId, message: "Workspace directory read failed" });
    expect(JSON.stringify(replay)).not.toContain("customer path and content");
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

  it("requests retained server evidence when browser evidence cannot be delivered", async () => {
    const limited = { ...report, evidenceScope: "client-only" };
    const fetch = vi.fn((_path: string, _init: RequestInit): Promise<Response> =>
      _path === "/api/diagnostics/report"
        ? Promise.resolve(new Response(JSON.stringify(limited), { status: 200 }))
        : Promise.resolve(new Response(null, { status: 429 })),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    await vi.waitFor(() => expect(clientDiagnosticPostFailureCount()).toBe(1));
    await expect(createSupportReport(correlationId)).resolves.toEqual(limited);
    const call = fetch.mock.calls.find(([path]) => path === "/api/diagnostics/report");
    expect(call).toBeDefined();
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ correlationId });
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("frames");
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
      "/api/diagnostics/report",
    ]);
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toEqual({
      correlationId,
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetch.mockResolvedValueOnce(reportResponse());
    expect(await createSupportReport(correlationId)).toEqual(report);
    expect(fetch).toHaveBeenCalledTimes(5);
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
    expect(fetch.mock.calls.filter(([path]) => path === "/api/diagnostics/client")).toHaveLength(7);
    expect(fetch.mock.calls.filter(([path]) => path === "/api/diagnostics/report")).toHaveLength(8);
  });

  it("exports a limited artifact when only diagnostic acknowledgement stalls", async () => {
    const stage = new AbortController();
    const overall = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 15_000 ? stage.signal : overall.signal,
    );
    const limited = { ...report, evidenceScope: "client-only" };
    const fetch = vi.fn((path: string): Promise<Response> =>
      path === "/api/diagnostics/report"
        ? Promise.resolve(new Response(JSON.stringify(limited), { status: 200 }))
        : new Promise(() => undefined),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fanOutClientDiagnostic("[keiko] uncaught window error: TypeError", diagnostic);
    const delivery = vi.spyOn(clientDiagnostics, "ensureClientDiagnosticDelivery");
    const pending = createSupportReport(correlationId);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled());
    stage.abort(new DOMException("Diagnostic deadline expired", "TimeoutError"));
    await expect(pending).resolves.toEqual(limited);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/diagnostics/client",
      "/api/diagnostics/report",
    ]);
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
    const delivery = vi.spyOn(clientDiagnostics, "ensureClientDiagnosticDelivery");
    const result = createSupportReport(correlationId);
    const settled = expect(result).rejects.toMatchObject({
      name: "SupportReportEvidenceUnavailable",
    });
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith(correlationId, expect.any(AbortSignal)),
    );
    deadline.abort(new DOMException("Expired", "TimeoutError"));
    await settled;
    expect(fetch).toHaveBeenCalledOnce();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(35_000);
  });
});
