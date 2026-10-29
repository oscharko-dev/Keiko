import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthClient } from "./oauth-client.js";

const issuer = "https://identity.example.test";
const url = "https://tools.example.test/mcp";
function fixture(scope: string | null = "tools.read"): {
  client: ReturnType<typeof createMcpOAuthClient>;
  saved: () => Readonly<Record<string, unknown>> | undefined;
  requests: { url: string; body: string }[];
  revoke: () => void;
} {
  let saved: Readonly<Record<string, unknown>> | undefined;
  let current = true;
  const requests: { url: string; body: string }[] = [];
  const client = createMcpOAuthClient({
    url,
    oauth: { issuer, clientId: "synthetic-public-client", ...(scope === null ? {} : { scope }) },
    persistence: {
      read: () => saved,
      write: (value) => {
        saved = value;
      },
    },
    beforeEffect: () => current,
    fetch: async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.text() });
      if (request.url.includes("oauth-protected-resource"))
        return Response.json({
          resource: url,
          authorization_servers: [issuer],
          scopes_supported: ["tools.read", "tools.write"],
        });
      if (request.url.includes("well-known"))
        return Response.json({
          issuer,
          scopes_supported: ["tools.read", "tools.write", "offline_access"],
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "synthetic-refresh-token",
        scope: "tools.read",
      });
    },
  });
  return {
    client,
    saved: () => saved,
    requests,
    revoke: (): void => {
      current = false;
    },
  };
}
describe("central MCP OAuth SDK adapter", () => {
  it("refuses returned scopes beyond the operator grant before persisting tokens", async () => {
    const f = fixture("tools.none");
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await expect(f.client.complete("synthetic-code", issuer)).rejects.toThrow();
    expect(f.saved()).toBeUndefined();
  });

  it("never requests all advertised resource scopes when no operator scope is configured", async () => {
    const f = fixture(null);
    const authorization = new URL(
      await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state"),
    );
    expect(authorization.searchParams.has("scope")).toBe(false);
  });

  it("binds PKCE, issuer, resource and scope and persists only after the exchange", async () => {
    const f = fixture();
    const auth = new URL(await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state"));
    expect(auth.searchParams.get("state")).toBe("synthetic-state");
    expect(auth.searchParams.get("resource")).toBe(url);
    expect(auth.searchParams.get("scope")).toBe("tools.read");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.saved()).toBeUndefined();
    await f.client.complete("synthetic-code", issuer);
    expect(await f.client.token()).toBe("synthetic-access-token");
    expect(f.saved()?.tokens).toMatchObject({ issuer, access_token: "synthetic-access-token" });
    expect(f.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
  });
  it("refuses a mismatched callback issuer before exchanging the code", async () => {
    const f = fixture();
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await expect(
      f.client.complete("synthetic-code", "https://attacker.example.test"),
    ).rejects.toThrow();
    expect(f.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(0);
    expect(f.saved()).toBeUndefined();
  });
  it("refuses revoked authority before discovery or token exchange", async () => {
    const f = fixture();
    f.revoke();
    await expect(
      f.client.start("http://127.0.0.1:1999/callback", "synthetic-state"),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it("coalesces concurrent refreshes without issuing any resource request", async () => {
    const f = fixture();
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await f.client.complete("synthetic-code", issuer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_700_000);
    try {
      expect(await Promise.all([f.client.token(), f.client.token()])).toEqual([
        "synthetic-access-token",
        "synthetic-access-token",
      ]);
      expect(f.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      expect(f.requests.at(-1)?.body).toContain("grant_type=refresh_token");
      expect(f.requests.some((request) => request.url === url)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
