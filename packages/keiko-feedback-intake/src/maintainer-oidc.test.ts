import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  clientSecretBasic: vi.fn(),
  clientSecretPost: vi.fn(),
  discovery: vi.fn(),
  randomNonce: vi.fn(),
  randomPKCECodeVerifier: vi.fn(),
  randomState: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("openid-client", () => ({
  authorizationCodeGrant: mocks.authorizationCodeGrant,
  buildAuthorizationUrl: mocks.buildAuthorizationUrl,
  calculatePKCECodeChallenge: mocks.calculatePKCECodeChallenge,
  ClientSecretBasic: mocks.clientSecretBasic,
  ClientSecretPost: mocks.clientSecretPost,
  discovery: mocks.discovery,
  randomNonce: mocks.randomNonce,
  randomPKCECodeVerifier: mocks.randomPKCECodeVerifier,
  randomState: mocks.randomState,
}));

import { loadMaintainerRuntimeConfig } from "./maintainer-config.js";
import { createMaintainerOidcClient } from "./maintainer-oidc.js";

function config(
  method: "client_secret_basic" | "client_secret_post" = "client_secret_basic",
): ReturnType<typeof loadMaintainerRuntimeConfig> {
  return loadMaintainerRuntimeConfig({
    KEIKO_FEEDBACK_MAINTAINER_ENABLED: "true",
    KEIKO_FEEDBACK_MAINTAINER_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MAINTAINER_PORT: "9443",
    KEIKO_FEEDBACK_MAINTAINER_PUBLIC_ORIGIN: "https://maintainer.example",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "https://idp.example/tenant/",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_ID: "keiko-client",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_AUTH_METHOD: method,
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ID_TOKEN_ALG: "PS256",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_REDIRECT_URI:
      "https://maintainer.example/v1/maintainer/auth/callback",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_CLAIM: "groups",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON: '{"reviewers":["feedback.review"]}',
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_POLICY_VERSION: "policy-v1",
    KEIKO_FEEDBACK_MAINTAINER_LEGAL_HOLD_POLICIES_JSON: "[]",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_IDLE_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_ABSOLUTE_MS: "120000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_PER_SOURCE_LIMIT: "5",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_GLOBAL_LIMIT: "20",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_WINDOW_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_CONCURRENCY_LIMIT: "4",
  });
}

describe("openid-client maintainer adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockResolvedValue("0123456789abcdef\n");
    mocks.clientSecretBasic.mockReturnValue("basic-auth");
    mocks.clientSecretPost.mockReturnValue("post-auth");
    mocks.discovery.mockResolvedValue("discovered-configuration");
    mocks.randomPKCECodeVerifier.mockReturnValue("pkce-verifier");
    mocks.randomState.mockReturnValue("state-value");
    mocks.randomNonce.mockReturnValue("nonce-value");
    mocks.calculatePKCECodeChallenge.mockResolvedValue("pkce-challenge");
    mocks.buildAuthorizationUrl.mockReturnValue(new URL("https://idp.example/authorize"));
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        iss: "https://idp.example/tenant/",
        sub: "maintainer-1",
        aud: "keiko-client",
      }),
    });
  });

  it.each([
    ["client_secret_basic", "basic-auth"],
    ["client_secret_post", "post-auth"],
  ] as const)("discovers the exact issuer using %s", async (method, expectedAuth) => {
    await createMaintainerOidcClient(config(method));
    expect(
      method === "client_secret_basic" ? mocks.clientSecretBasic : mocks.clientSecretPost,
    ).toHaveBeenCalledWith("0123456789abcdef");
    const discovery = mocks.discovery.mock.calls[0];
    expect((discovery?.[0] as URL).href).toBe("https://idp.example/tenant/");
    expect(discovery?.slice(1)).toEqual([
      "keiko-client",
      { client_secret: "0123456789abcdef", id_token_signed_response_alg: "PS256" },
      expectedAuth,
    ]);
  });

  it("sends transaction-specific PKCE S256, state, nonce, and the fixed redirect", async () => {
    const client = await createMaintainerOidcClient(config());
    await expect(client.begin()).resolves.toMatchObject({
      state: "state-value",
      nonce: "nonce-value",
      verifier: "pkce-verifier",
    });
    expect(mocks.calculatePKCECodeChallenge).toHaveBeenCalledWith("pkce-verifier");
    expect(mocks.buildAuthorizationUrl).toHaveBeenCalledWith("discovered-configuration", {
      response_type: "code",
      scope: "openid",
      redirect_uri: "https://maintainer.example/v1/maintainer/auth/callback",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      state: "state-value",
      nonce: "nonce-value",
    });
  });

  it("uses openid-client's verified grant path with every stored transaction check", async () => {
    const client = await createMaintainerOidcClient(config());
    const callback = new URL(
      "https://maintainer.example/v1/maintainer/auth/callback?code=code&state=state-value",
    );
    await expect(
      client.exchange(callback, {
        state: "state-value",
        nonce: "nonce-value",
        verifier: "pkce-verifier",
        redirectUri: "https://maintainer.example/v1/maintainer/auth/callback",
      }),
    ).resolves.toMatchObject({ issuer: "https://idp.example/tenant/", subject: "maintainer-1" });
    expect(mocks.authorizationCodeGrant).toHaveBeenCalledWith(
      "discovered-configuration",
      callback,
      {
        pkceCodeVerifier: "pkce-verifier",
        expectedState: "state-value",
        expectedNonce: "nonce-value",
        idTokenExpected: true,
      },
    );
  });

  it("fails before the grant if the persisted redirect differs", async () => {
    const client = await createMaintainerOidcClient(config());
    await expect(
      client.exchange(new URL("https://maintainer.example/v1/maintainer/auth/callback"), {
        state: "state-value",
        nonce: "nonce-value",
        verifier: "pkce-verifier",
        redirectUri: "https://evil.example/callback",
      }),
    ).rejects.toThrow("OIDC callback failed");
    expect(mocks.authorizationCodeGrant).not.toHaveBeenCalled();
  });
});
