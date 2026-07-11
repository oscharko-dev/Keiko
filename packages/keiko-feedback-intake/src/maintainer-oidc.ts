import { readFile } from "node:fs/promises";
import * as oidc from "openid-client";
import type { MaintainerRuntimeConfig } from "./maintainer-config.js";

export interface OidcTransactionMaterial {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly authorizationUrl: URL;
}

export interface StoredOidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface MaintainerOidcClient {
  begin(): Promise<OidcTransactionMaterial>;
  exchange(callbackUrl: URL, transaction: StoredOidcTransaction): Promise<VerifiedOidcIdentity>;
}

function enabledConfig(
  config: MaintainerRuntimeConfig,
): Extract<MaintainerRuntimeConfig, { readonly enabled: true }> {
  if (!config.enabled) throw new Error("Maintainer OIDC is disabled");
  return config;
}

async function clientSecret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 16 || value.length > 4_096) throw new Error("Invalid OIDC client secret file");
  return value;
}

export async function createMaintainerOidcClient(
  input: MaintainerRuntimeConfig,
): Promise<MaintainerOidcClient> {
  const config = enabledConfig(input);
  const secret = await clientSecret(config.clientSecretFile);
  const authentication =
    config.clientAuthMethod === "client_secret_basic"
      ? oidc.ClientSecretBasic(secret)
      : oidc.ClientSecretPost(secret);
  const discovered = await oidc.discovery(
    new URL(config.issuer),
    config.clientId,
    { client_secret: secret, id_token_signed_response_alg: config.idTokenAlgorithm },
    authentication,
  );
  return {
    begin: () => beginOidc(discovered, config.redirectUri),
    exchange: async (callbackUrl, transaction): Promise<VerifiedOidcIdentity> => {
      if (transaction.redirectUri !== config.redirectUri) throw new Error("OIDC callback failed");
      const tokens = await oidc.authorizationCodeGrant(discovered, callbackUrl, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (
        claims === undefined ||
        typeof claims.iss !== "string" ||
        typeof claims.sub !== "string"
      ) {
        throw new Error("OIDC callback failed");
      }
      return { issuer: claims.iss, subject: claims.sub, claims };
    },
  };
}

async function beginOidc(
  config: oidc.Configuration,
  redirectUri: string,
): Promise<OidcTransactionMaterial> {
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    response_type: "code",
    scope: "openid",
    redirect_uri: redirectUri,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { state, nonce, verifier, authorizationUrl };
}
