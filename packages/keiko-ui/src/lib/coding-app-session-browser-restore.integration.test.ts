import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLocalCodingAppSession, LOCAL_SESSION_TIMEOUT_MS } from "./coding-app-session-client";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const LOCAL = "/api/coding-workbench/app-session/local-session";
const INSPECT = "/api/coding-workbench/app-session/browser";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetClientDiagnosticWriter();
});

describe("actual browser client session bootstrap", () => {
  it("confirms then inspects a usable session without opening private-key storage", async () => {
    const records: unknown[] = [];
    setClientDiagnosticWriter((message, meta) => records.push({ message, meta }));
    const fetchMock = vi.fn((path: string): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            path === LOCAL
              ? { schemaVersion: "1" }
              : { state: "active", requests: [], approvals: [] },
          ),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureLocalCodingAppSession()).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([LOCAL, INSPECT]);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain('"operation":"session-restore","outcome":"active"');
    expect(serialized).not.toContain('"operation":"key-load"');
  });

  it("does not extend the original confirmation deadline for optional restoration", async () => {
    setClientDiagnosticWriter(() => undefined);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchMock = vi.fn((path: string, init: RequestInit): Promise<Response> => {
      if (path === LOCAL) return Promise.resolve(new Response('{"schemaVersion":"1"}'));
      return new Promise((_resolve, reject): void => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const operation = ensureLocalCodingAppSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(timeout.mock.calls[0]).toEqual([LOCAL_SESSION_TIMEOUT_MS]);
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    await expect(operation).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([LOCAL, INSPECT]);
  });

  it("settles confirmation with unavailable restoration and does not claim authenticated access", async () => {
    const records: unknown[] = [];
    setClientDiagnosticWriter((message, meta) => records.push({ message, meta }));
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify(path === LOCAL ? { schemaVersion: "1" } : { state: "unavailable" }),
          ),
        ),
      ),
    );
    await expect(ensureLocalCodingAppSession()).resolves.toBe(true);
    expect(JSON.stringify(records)).not.toContain('"outcome":"active"');
  });
});
