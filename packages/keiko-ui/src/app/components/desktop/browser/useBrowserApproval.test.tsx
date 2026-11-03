import { act, cleanup, renderHook } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { createBrowserApprovalKey } from "@/lib/browser-approval-crypto";
import {
  createLocalBrowserApprovalClient,
  type BrowserApprovalAttempt,
  type BrowserApprovalClient,
} from "@/lib/browser-approval-client";
import { useBrowserApproval } from "./useBrowserApproval";

vi.mock("@/lib/browser-approval-client", () => ({ createLocalBrowserApprovalClient: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

let attempt: BrowserApprovalAttempt;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  attempt = {
    key: await createBrowserApprovalKey(),
    correlationId: "corr_abort_control",
    request: {
      requestId: `brq_${"a".repeat(32)}`,
      comparisonCode: "01234567",
      requestedAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_000_300_000,
      rememberRequested: false,
      publicKeyFingerprint: "b".repeat(64),
    },
  };
  vi.mocked(reportClientDiagnostic).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function client(): BrowserApprovalClient {
  return {
    begin: vi.fn().mockResolvedValue(attempt),
    complete: vi.fn().mockResolvedValue({ state: "active", persistence: "session" }),
    restore: vi.fn().mockResolvedValue(false),
  };
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) throw new TypeError("Expected a controller-owned signal");
  return new Promise((_resolve, reject): void => {
    signal.addEventListener("abort", (): void => reject(signal.reason), { once: true });
  });
}

describe("browser approval cancellation ownership", () => {
  it("does not report a failed request when its mounted owner cancels begin", async () => {
    const transport = client();
    vi.mocked(transport.begin).mockImplementation((_remember, signal) => untilAborted(signal));
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(transport);
    const { result, unmount } = renderHook(useBrowserApproval);
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.begin(false);
    });
    expect(transport.begin).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      await pending;
    });
    expect(vi.mocked(transport.begin).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it("does not report a failed poll when its mounted owner cancels completion", async () => {
    const transport = client();
    vi.mocked(transport.complete).mockImplementation((_attempt, signal) => untilAborted(signal));
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(transport);
    const { result, unmount } = renderHook(useBrowserApproval);
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.begin(false);
    });
    expect(transport.complete).toHaveBeenCalledOnce();
    expect(result.current.view.phase).toBe("pending");
    unmount();
    await act(async () => {
      await pending;
    });
    expect(vi.mocked(transport.complete).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it.each(["begin", "complete"] as const)("retains a genuine %s failure", async (stage) => {
    const transport = client();
    vi.mocked(transport[stage]).mockRejectedValue(new TypeError("Synthetic transport failure"));
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(transport);
    const { result } = renderHook(useBrowserApproval);
    await act(async () => result.current.begin(false));
    expect(result.current.view.phase).toBe(stage === "begin" ? "unavailable" : "failed");
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ errorKind: expect.any(String), errorEvidence: expect.any(Object) }),
    );
  });

  it.each(["begin", "complete"] as const)(
    "reports an unowned AbortError from %s",
    async (stage) => {
      const transport = client();
      vi.mocked(transport[stage]).mockRejectedValue(
        new DOMException("Synthetic abort", "AbortError"),
      );
      vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(transport);
      const { result } = renderHook(useBrowserApproval);
      await act(async () => result.current.begin(false));
      expect(result.current.view.phase).toBe(stage === "begin" ? "unavailable" : "failed");
      expect(vi.mocked(transport.begin).mock.calls[0]?.[1]?.aborted).toBe(false);
      expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    },
  );

  it("does not let a superseded poll overwrite the new accepted request", async () => {
    const transport = client();
    vi.mocked(transport.complete).mockImplementationOnce((_attempt, signal) =>
      untilAborted(signal),
    );
    vi.mocked(createLocalBrowserApprovalClient).mockReturnValue(transport);
    const { result } = renderHook(useBrowserApproval);
    let previous: Promise<void> | undefined;
    await act(async () => {
      previous = result.current.begin(false);
    });
    expect(result.current.view.phase).toBe("pending");
    await act(async () => {
      await result.current.begin(true);
      await previous;
    });
    expect(vi.mocked(transport.complete).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(vi.mocked(transport.complete).mock.calls[1]?.[1]?.aborted).toBe(false);
    expect(result.current.view.phase).toBe("active");
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });
});
