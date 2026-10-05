import { afterEach, expect, it, vi } from "vitest";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";
import { CORRELATION_HEADER } from "./bff-correlation";
import {
  LOCAL_SESSION_TIMEOUT_MS,
  codingAppSessionPairingSettled,
  redeemCodingAppSessionPairingOnBoot,
} from "./coding-app-session-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetClientDiagnosticWriter();
  window.location.hash = "";
});

it("bounds one shared boot pairing request and settles all waiting readers after a logged timeout", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => new AbortController().signal);
  timeout.mockReturnValueOnce(deadline.signal);
  const diagnostic = vi.fn();
  setClientDiagnosticWriter(diagnostic);
  let release: ((error: unknown) => void) | undefined;
  const fetchMock = vi.fn((path: string, init: RequestInit) => {
    if (!path.endsWith("/pair")) return Promise.resolve(new Response('{"schemaVersion":"1"}'));
    return new Promise<Response>((_resolve, reject) => {
      release = reject;
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  window.location.hash = encodeCodingAppSessionPairingFragment({
    requestId: "private-launcher-request",
    issuedAtMs: 1_720_000_000_000,
    claim: "c".repeat(64),
  });
  const first = redeemCodingAppSessionPairingOnBoot();
  const reader = codingAppSessionPairingSettled();
  try {
    expect(reader).toBe(first);
    expect(window.location.hash).toBe("");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(LOCAL_SESSION_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(deadline.signal);
    deadline.abort(new DOMException("private timeout detail", "TimeoutError"));
    await expect(first).resolves.toBe(true);
    const requestId = new Headers(fetchMock.mock.calls[0]?.[1].headers).get(CORRELATION_HEADER);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[keiko] local app session pairing failed: TimeoutError",
      {
        correlationId: requestId,
        errorKind: "timeout",
        errorEvidence: { errorClass: "TimeoutError", frames: [], causeChain: [] },
      },
    );
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/coding-workbench/app-session/pair",
      "/api/coding-workbench/app-session/local-session",
    ]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|c{64}/u);
  } finally {
    release?.(new DOMException("cleanup", "AbortError"));
    await first;
  }
});
