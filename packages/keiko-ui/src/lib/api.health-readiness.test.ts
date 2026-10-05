import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api";
import { CORRELATION_HEADER } from "./bff-correlation";

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
  it.each([null, false, {}, { readiness: "new-server-value" }])(
    "retains a body-free invalid marker for present malformed diagnostics %j",
    async (diagnostics) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              status: "ok",
              version: "1.2.3",
              diagnostics,
            }),
            { status: 200 },
          ),
        ),
      );
      expect(await fetchHealth()).toEqual({
        status: "ok",
        version: "1.2.3",
        diagnosticsInvalid: true,
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
          { status: 200 },
        ),
      ),
    );
    expect(await fetchHealth()).toEqual({ status: "ok", version: "1.2.3" });
  });
});
