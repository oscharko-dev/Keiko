import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("health diagnostics validation", () => {
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
