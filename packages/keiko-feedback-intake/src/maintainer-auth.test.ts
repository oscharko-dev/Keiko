import { describe, expect, it, vi } from "vitest";
import { createMaintainerAuthService, type MaintainerAuthService } from "./maintainer-auth.js";
import { loadMaintainerRuntimeConfig } from "./maintainer-config.js";
import type {
  MaintainerOidcClient,
  StoredOidcTransaction,
  VerifiedOidcIdentity,
} from "./maintainer-oidc.js";

const AT = new Date("2026-07-11T12:00:00.000Z");
const CALLBACK = new URL(
  "https://maintainer.example/v1/maintainer/auth/callback?code=code&state=state",
);

type EnabledConfig = Extract<
  ReturnType<typeof loadMaintainerRuntimeConfig>,
  { readonly enabled: true }
>;

function config(): EnabledConfig {
  const loaded = loadMaintainerRuntimeConfig({
    KEIKO_FEEDBACK_MAINTAINER_ENABLED: "true",
    KEIKO_FEEDBACK_MAINTAINER_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MAINTAINER_PORT: "9443",
    KEIKO_FEEDBACK_MAINTAINER_PUBLIC_ORIGIN: "https://maintainer.example",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "https://idp.example/tenant/",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_ID: "keiko",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ID_TOKEN_ALG: "RS256",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_REDIRECT_URI:
      "https://maintainer.example/v1/maintainer/auth/callback",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_CLAIM: "groups",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON:
      '{"reviewers":["feedback.review"],"security":["feedback.security","feedback.audit"]}',
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_POLICY_VERSION: "policy-v1",
    KEIKO_FEEDBACK_MAINTAINER_LEGAL_HOLD_POLICIES_JSON: "[]",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_IDLE_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_ABSOLUTE_MS: "120000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_PER_SOURCE_LIMIT: "5",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_GLOBAL_LIMIT: "20",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_WINDOW_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_CONCURRENCY_LIMIT: "4",
  });
  if (!loaded.enabled) throw new Error("test config");
  return loaded;
}

interface Harness {
  readonly auth: MaintainerAuthService;
  readonly exchange: ReturnType<typeof vi.fn>;
  readonly store: {
    readonly createTransaction: ReturnType<typeof vi.fn>;
    readonly consumeTransaction: ReturnType<typeof vi.fn>;
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly session: ReturnType<typeof vi.fn>;
    readonly revoke: ReturnType<typeof vi.fn>;
  };
}

function harness(identity: VerifiedOidcIdentity): Harness {
  let available = true;
  const exchange = vi.fn().mockResolvedValue(identity);
  const oidc: MaintainerOidcClient = {
    begin: vi.fn().mockResolvedValue({
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      authorizationUrl: new URL("https://idp.example/authorize"),
    }),
    exchange,
  };
  const store = {
    createTransaction: vi.fn().mockResolvedValue("browser-capability"),
    consumeTransaction: vi.fn(
      (state: string, browser: string): Promise<StoredOidcTransaction | undefined> => {
        if (!available || state !== "state" || browser !== "browser-capability") {
          return Promise.resolve(undefined);
        }
        available = false;
        return Promise.resolve({
          state,
          nonce: "nonce",
          verifier: "verifier",
          redirectUri: "https://maintainer.example/v1/maintainer/auth/callback",
        });
      },
    ),
    createSession: vi.fn().mockResolvedValue({
      capability: "session-capability",
      csrfToken: "csrf",
      absoluteExpiresAt: new Date(AT.getTime() + 120_000),
    }),
    session: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  return { exchange, store, auth: createMaintainerAuthService(config(), oidc, store, () => AT) };
}

function identity(overrides: Partial<VerifiedOidcIdentity> = {}): VerifiedOidcIdentity {
  return {
    issuer: "https://idp.example/tenant/",
    subject: "maintainer-1",
    claims: { groups: ["reviewers"] },
    ...overrides,
  };
}

describe("maintainer authentication", () => {
  it("binds a one-time transaction to the browser capability", async (): Promise<void> => {
    const { auth, exchange } = harness(identity());
    await expect(
      auth.callback(
        new URL("https://maintainer.example/v1/maintainer/auth/callback?code=code"),
        "browser-capability",
      ),
    ).rejects.toMatchObject({ code: "invalid-callback" });
    await expect(auth.callback(CALLBACK, "wrong-browser")).rejects.toMatchObject({
      code: "invalid-callback",
    });
    expect(exchange).not.toHaveBeenCalled();
    await expect(auth.callback(CALLBACK, "browser-capability")).resolves.toMatchObject({
      capability: "session-capability",
    });
    await expect(auth.callback(CALLBACK, "browser-capability")).rejects.toMatchObject({
      code: "invalid-callback",
    });
  });

  it("stores each login transaction with the configured redirect and trusted time", async () => {
    const { auth, store } = harness(identity());
    await expect(auth.login()).resolves.toMatchObject({ browserCapability: "browser-capability" });
    expect(store.createTransaction).toHaveBeenCalledWith(
      "state",
      "nonce",
      "verifier",
      "https://maintainer.example/v1/maintainer/auth/callback",
      AT,
    );
  });

  it("fails closed for issuer mismatch and an identity with no mapped permission", async () => {
    await expect(
      harness(identity({ issuer: "https://idp.example/other" })).auth.callback(
        CALLBACK,
        "browser-capability",
      ),
    ).rejects.toMatchObject({ code: "invalid-callback" });
    await expect(
      harness(identity({ claims: { groups: ["unknown"] } })).auth.callback(
        CALLBACK,
        "browser-capability",
      ),
    ).rejects.toMatchObject({ code: "authorization-denied" });
  });

  it("rejects mixed-type, oversized, and overlong permission claims", async () => {
    for (const groups of [
      ["reviewers", 7],
      Array.from({ length: 33 }, () => "reviewers"),
      ["r".repeat(129)],
    ]) {
      await expect(
        harness(identity({ claims: { groups } })).auth.callback(CALLBACK, "browser-capability"),
      ).rejects.toMatchObject({ code: "authorization-denied" });
    }
  });

  it("revokes the prior capability before rotating the session", async (): Promise<void> => {
    const { auth, store } = harness(identity({ claims: { groups: ["security"] } }));
    await auth.callback(CALLBACK, "browser-capability", "old-session");
    expect(store.revoke).toHaveBeenCalledWith("old-session", AT);
    expect(store.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      store.createSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(store.createSession).toHaveBeenCalledWith(
      "https://idp.example/tenant/",
      "maintainer-1",
      ["feedback.audit", "feedback.security"],
      "policy-v1",
      AT,
    );
  });
});
