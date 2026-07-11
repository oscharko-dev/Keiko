import { describe, expect, it } from "vitest";
import { loadMaintainerRuntimeConfig } from "./maintainer-config.js";

function environment(): Record<string, string> {
  return {
    KEIKO_FEEDBACK_MAINTAINER_ENABLED: "true",
    KEIKO_FEEDBACK_MAINTAINER_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MAINTAINER_PORT: "9443",
    KEIKO_FEEDBACK_MAINTAINER_PUBLIC_ORIGIN: "https://review.example",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "https://identity.example/tenant/regulated",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_ID: "keiko-review",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc-client",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ID_TOKEN_ALG: "RS256",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_REDIRECT_URI:
      "https://review.example/v1/maintainer/auth/callback",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_CLAIM: "keiko_roles",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON:
      '{"reviewers":["feedback.review"],"security":["feedback.security"]}',
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_POLICY_VERSION: "policy-v1",
    KEIKO_FEEDBACK_MAINTAINER_LEGAL_HOLD_POLICIES_JSON: '["operator-policy-1"]',
    KEIKO_FEEDBACK_MAINTAINER_SESSION_IDLE_MS: "600000",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_ABSOLUTE_MS: "900000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_PER_SOURCE_LIMIT: "5",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_GLOBAL_LIMIT: "20",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_WINDOW_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_CONCURRENCY_LIMIT: "4",
  };
}

describe("maintainer runtime configuration", () => {
  it("is disabled by default and accepts exact confidential OIDC configuration", () => {
    expect(loadMaintainerRuntimeConfig({})).toEqual({ enabled: false });
    expect(loadMaintainerRuntimeConfig(environment())).toMatchObject({
      enabled: true,
      issuer: "https://identity.example/tenant/regulated",
      clientAuthMethod: "client_secret_basic",
      idTokenAlgorithm: "RS256",
    });
  });

  it.each([
    ["public client", { KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_AUTH_METHOD: "none" }],
    ["insecure issuer", { KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "http://id.example" }],
    ["issuer query", { KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "https://id.example/t?q=1" }],
    [
      "wrong redirect",
      { KEIKO_FEEDBACK_MAINTAINER_OIDC_REDIRECT_URI: "https://review.example/callback" },
    ],
    ["unsafe algorithm", { KEIKO_FEEDBACK_MAINTAINER_OIDC_ID_TOKEN_ALG: "HS256" }],
    ["session over fifteen minutes", { KEIKO_FEEDBACK_MAINTAINER_SESSION_ABSOLUTE_MS: "900001" }],
    ["control client id", { KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_ID: "keiko\nclient" }],
    [
      "oversized policy version",
      { KEIKO_FEEDBACK_MAINTAINER_PERMISSION_POLICY_VERSION: "p".repeat(65) },
    ],
    ["invalid claim path", { KEIKO_FEEDBACK_MAINTAINER_PERMISSION_CLAIM: "groups[0]" }],
    [
      "control claim value",
      { KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON: '{"bad\\nrole":["feedback.review"]}' },
    ],
    ["empty rules", { KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON: "{}" }],
    ["unknown permission", { KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON: '{"x":["admin"]}' }],
  ])("rejects %s", (_, patch) => {
    expect(() => loadMaintainerRuntimeConfig({ ...environment(), ...patch })).toThrow();
  });

  it("fails closed on partial disabled configuration", () => {
    expect(() =>
      loadMaintainerRuntimeConfig({ KEIKO_FEEDBACK_MAINTAINER_HOST: "127.0.0.1" }),
    ).toThrow("partially configured");
  });

  it("accepts an empty legal-hold allowlist to disable hold mutations", () => {
    expect(
      loadMaintainerRuntimeConfig({
        ...environment(),
        KEIKO_FEEDBACK_MAINTAINER_LEGAL_HOLD_POLICIES_JSON: "[]",
      }),
    ).toMatchObject({ enabled: true, legalHoldPolicyKeys: [] });
  });
});
