import { describe, expect, it } from "vitest";
import { createOpenCodeHttpClient, parseOpenCodeChildEndpoint } from "./opencodeHttpClient.js";

describe("OpenCode HTTP client", () => {
  it("accepts exactly one literal loopback startup endpoint", () => {
    expect(parseOpenCodeChildEndpoint("ready http://127.0.0.1:43123")).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:43123",
    });
    expect(parseOpenCodeChildEndpoint("http://127.0.0.1:1 http://127.0.0.1:2")).toEqual({
      ok: false,
      reason: "endpoint-invalid",
    });
  });
  it("uses Basic auth, rejects Origin and never follows redirects", async () => {
    let init: RequestInit | undefined;
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch: (_url, request) => {
        init = request;
        return Promise.resolve(new Response("{}", { status: 302, headers: { Location: "/x" } }));
      },
    });
    await expect(client.health()).resolves.toEqual({ ok: false, reason: "http-failed" });
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
    expect(new Headers(init?.headers).get("origin")).toBeNull();
  });
});
