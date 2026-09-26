import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useJourneyActions } from "./_useJourneyActions";

// B5-2 (epic #3384 audit): before this fix, `useJourneyActions`'s catch block discarded the
// caught error entirely — `failure` carried only which action failed, never why. A network
// error, an expired approval and a quota-exceeded rejection were therefore indistinguishable to
// every consumer. These tests pin the hook's own (owning-layer) contract directly, independent of
// how `CodingWorkbenchJourneyOutcome.tsx` happens to render it.
describe("useJourneyActions failure reason", () => {
  const writer = vi.fn();
  beforeEach(() => {
    setClientDiagnosticWriter(writer);
  });
  afterEach(() => {
    writer.mockReset();
    resetClientDiagnosticWriter();
    vi.restoreAllMocks();
  });

  it("carries the ApiError's own closed-vocabulary code as the failure reason (never discarded)", async () => {
    const { result } = renderHook(() => useJourneyActions("run-1"));
    await act(async () => {
      await result.current.invoke(
        "refresh",
        vi.fn().mockRejectedValue(new ApiError("READINESS_DIGEST_STALE", "stale", 409)),
      );
    });
    await waitFor(() =>
      expect(result.current.failure).toEqual({
        action: "refresh",
        reason: "READINESS_DIGEST_STALE",
      }),
    );
  });

  it("falls back to the bounded error class name for a native throw the BFF never saw", async () => {
    const { result } = renderHook(() => useJourneyActions("run-1"));
    await act(async () => {
      await result.current.invoke(
        "propose-ready",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      );
    });
    await waitFor(() =>
      expect(result.current.failure).toEqual({ action: "propose-ready", reason: "TypeError" }),
    );
  });

  it("logs the same body-free reason on the activity diagnostic, never the raw message", async () => {
    const { result } = renderHook(() => useJourneyActions("run-1"));
    await act(async () => {
      await result.current.invoke(
        "refresh",
        vi.fn().mockRejectedValue(new Error("private/customer-content token-value")),
      );
    });
    expect(writer).toHaveBeenCalledWith(
      "[keiko] journey action: refresh failed (reason=Error)",
      expect.objectContaining({ correlationId: "run-1" }),
    );
    expect(JSON.stringify(writer.mock.calls)).not.toMatch(/customer-content|token-value/);
  });

  it("resets the failure to null when a retry is invoked", async () => {
    const { result } = renderHook(() => useJourneyActions("run-1"));
    await act(async () => {
      await result.current.invoke("refresh", vi.fn().mockRejectedValue(new Error("boom")));
    });
    expect(result.current.failure).not.toBeNull();
    await act(async () => {
      await result.current.invoke("refresh", vi.fn().mockResolvedValue(undefined));
    });
    expect(result.current.failure).toBeNull();
  });
});
