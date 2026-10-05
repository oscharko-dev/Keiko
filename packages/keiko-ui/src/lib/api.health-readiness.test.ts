import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api";
import { CORRELATION_HEADER, responseCorrelationIdOf } from "./bff-correlation";

afterEach(() => vi.unstubAllGlobals());
describe("health diagnostics validation", () => {
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
