import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthClient } from "./oauth-client.js";

const issuer = "https://identity.example.test";
const url = "https://tools.example.test/mcp";
function refreshRejection(
  kind: true | "transient" | "invalid_client" | "unauthorized_client",
): Response {
  if (kind === true) return Response.json({ error: "invalid_grant" }, { status: 400 });
  if (kind === "transient")
    return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  return Response.json({ error: kind }, { status: 400 });
}

function fixture(
  scope: string | null = "tools.read",
  rotate = false,
  denyRefresh: boolean | "transient" | "invalid_client" | "unauthorized_client" = false,
  rejectedRefresh?: () => void,
): {
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
      if (denyRefresh && requests.at(-1)?.body.includes("grant_type=refresh_token")) {
        rejectedRefresh?.();
        return refreshRejection(denyRefresh);
      }
      return Response.json({
        access_token:
          rotate && requests.at(-1)?.body.includes("grant_type=refresh_token")
            ? "synthetic-rotated-access-token"
            : "synthetic-access-token",
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
      saved = undefined;
    },
  };
}
describe("central MCP OAuth SDK adapter", () => {
  it.each(["invalid_client", "unauthorized_client"] as const)(
    "retains refresh custody after a client configuration rejection: %s",
    async (failure) => {
      const f = fixture("tools.read", false, failure);
      await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
      await f.client.complete("synthetic-code", issuer);
      const before = f.saved();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3700000);
      try {
        await expect(f.client.token()).rejects.toThrow();
        expect(f.saved()).toEqual(before);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("retains refresh custody when the authorization server is temporarily unavailable", async () => {
    const f = fixture("tools.read", false, "transient");
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await f.client.complete("synthetic-code", issuer);
    const before = f.saved();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3700000);
    try {
      await expect(f.client.token()).rejects.toThrow();
      expect(f.saved()).toEqual(before);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not recreate deleted custody when a refresh rejection arrives after revocation", async () => {
    const f = fixture("tools.read", false, true, () => {
      f.revoke();
    });
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await f.client.complete("synthetic-code", issuer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3700000);
    try {
      await expect(f.client.token()).rejects.toThrow();
      expect(f.saved()).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("requires sign-in after an authoritative refresh rejection and never repeats it", async () => {
    const f = fixture("tools.read", false, true);
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await f.client.complete("synthetic-code", issuer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3700000);
    try {
      await expect(f.client.token()).rejects.toThrow();
      expect(f.client.authorized()).toBe(false);
      expect(f.saved()?.tokens).toBeUndefined();
      await expect(f.client.token()).rejects.toThrow();
      expect(f.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each([20000, -1])(
    "handles a non-refreshable token with %i milliseconds remaining",
    async (remaining) => {
      const fetch = vi.fn();
      const client = createMcpOAuthClient({
        url,
        oauth: { issuer, clientId: "synthetic-public" },
        persistence: {
          read: () => ({
            tokens: { issuer, access_token: "synthetic-short-token", token_type: "Bearer" },
            expiresAt: Date.now() + remaining,
          }),
          write: vi.fn(),
        },
        beforeEffect: () => true,
        fetch,
      });
      expect(client.authorized()).toBe(remaining > 0);
      if (remaining > 0) expect(await client.token()).toBe("synthetic-short-token");
      else await expect(client.token()).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps overlapping access tokens in the credential floor across refresh and restart", async () => {
    const f = fixture("tools.read", true);
    await f.client.start("http://127.0.0.1:1999/callback", "synthetic-state");
    await f.client.complete("synthetic-code", issuer);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3571000);
    try {
      expect(await f.client.token()).toBe("synthetic-rotated-access-token");
      expect(f.client.credentials()).toContain("synthetic-access-token");
      const reopened = createMcpOAuthClient({
        url,
        oauth: { issuer, clientId: "synthetic-public-client", scope: "tools.read" },
        persistence: { read: f.saved, write: vi.fn() },
        beforeEffect: () => true,
        fetch: vi.fn(),
      });
      expect(reopened.credentials()).toContain("synthetic-access-token");
      vi.mocked(Date.now).mockReturnValue(now + 3700000);
      expect(reopened.credentials()).not.toContain("synthetic-access-token");
    } finally {
      vi.restoreAllMocks();
    }
  });

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
