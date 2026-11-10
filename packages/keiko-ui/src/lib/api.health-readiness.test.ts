import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api";
import { CORRELATION_HEADER, responseCorrelationIdOf } from "./bff-correlation";

afterEach(() => vi.unstubAllGlobals());
describe("health diagnostics validation", () => {
  it.each([
    { readiness: "ready", reason: "none" },
    { readiness: "withheld", reason: "vault-unreadable" },
    { readiness: "withheld", reason: "vault-migration-failed" },
  ])(
    "retains only closed Memory readiness and keeps the observed response correlation %#",
    async (memory) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              status: "ok",
              version: "1.2.3",
              memory,
            }),
            { headers: { [CORRELATION_HEADER]: "memory-readiness-response" } },
          ),
        ),
      );
      const health = await fetchHealth();
      expect(health.memory).toEqual(memory);
      expect(responseCorrelationIdOf(health)).toBe("memory-readiness-response");
    },
  );
  it.each([
    { readiness: "withheld", reason: "raw database details" },
    { readiness: "ready", reason: "vault-migration-failed" },
    { readiness: "withheld", reason: "vault-migration-failed", sql: "SELECT private" },
  ])(
    "withholds an invalid optional Memory projection without reflecting its content %#",
    async (memory) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ status: "ok", version: "1.2.3", memory })),
          ),
      );
      expect(await fetchHealth()).toEqual({ status: "ok", version: "1.2.3" });
    },
  );
  it("sends the caller's health observation correlation on the actual request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok", version: "1.2.3" })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchHealth("observed-health-request-123");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(CORRELATION_HEADER)).toBe(
      "observed-health-request-123",
    );
  });
  it.each([
    [null, "null-shape"],
    [false, "snapshot-shape"],
    [{}, "snapshot-shape"],
    [{ readiness: "new-server-value" }, "readiness-value"],
  ])(
    "retains a body-free invalid marker for present malformed diagnostics %j",
    async (diagnostics, diagnosticsInvalidReason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              status: "ok",
              version: "1.2.3",
              diagnostics,
            }),
            { status: 200, headers: { [CORRELATION_HEADER]: "server-health-response" } },
          ),
        ),
      );
      const health = await fetchHealth("client-health-request");
      expect(responseCorrelationIdOf(health)).toBe("server-health-response");
      expect(health).toEqual({
        status: "ok",
        version: "1.2.3",
        diagnosticsInvalid: true,
        diagnosticsInvalidReason,
      });
    },
  );
  it("keeps truly absent optional diagnostics quiet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            version: "1.2.3",
          }),
          { status: 200, headers: { [CORRELATION_HEADER]: "server-health-response" } },
        ),
      ),
    );
    expect(await fetchHealth()).toEqual({ status: "ok", version: "1.2.3" });
  });
});
