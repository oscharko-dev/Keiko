import { expect, vi } from "vitest";
import { isClientDiagnosticIngestRequest } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { ClientDiagnosticMeta } from "@/lib/client-diagnostics";
import {
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
} from "@/lib/install-client-diagnostics";

/** Round-trip captured component evidence through the real message transport and wire validator. */
export async function expectDiagnosticWireAccepted(
  reports: readonly { readonly message: string; readonly meta: ClientDiagnosticMeta | undefined }[],
): Promise<void> {
  expect(reports.length).toBeGreaterThan(0);
  resetClientDiagnosticPostStateForTests();
  const post = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  try {
    for (const report of reports) fanOutClientDiagnostic(report.message, report.meta);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(reports.length));
    for (const [url, init] of post.mock.calls) {
      expect(url).toBe("/api/diagnostics/client");
      const payload = init?.body;
      if (typeof payload !== "string") throw new TypeError("Expected a diagnostic JSON request");
      const body: unknown = JSON.parse(payload);
      expect(isClientDiagnosticIngestRequest(body), JSON.stringify(body)).toBe(true);
    }
  } finally {
    post.mockRestore();
    resetClientDiagnosticPostStateForTests();
  }
}
