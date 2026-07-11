import {
  isFeedbackMaintainerPermissionV1,
  type FeedbackMaintainerPermissionV1,
} from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import { isFeedbackLegalHoldPolicyAllowlistV1 } from "@oscharko-dev/keiko-contracts/feedback-review";

type Environment = Readonly<Record<string, string | undefined>>;
export type OidcClientAuthMethod = "client_secret_basic" | "client_secret_post";
export type OidcIdTokenAlgorithm = "RS256" | "PS256" | "ES256";

export interface MaintainerPermissionRule {
  readonly claimValue: string;
  readonly permissions: readonly FeedbackMaintainerPermissionV1[];
}

export type MaintainerRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly host: string;
      readonly port: number;
      readonly publicOrigin: string;
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecretFile: string;
      readonly clientAuthMethod: OidcClientAuthMethod;
      readonly idTokenAlgorithm: OidcIdTokenAlgorithm;
      readonly redirectUri: string;
      readonly permissionClaim: string;
      readonly permissionRules: readonly MaintainerPermissionRule[];
      readonly permissionPolicyVersion: string;
      readonly legalHoldPolicyKeys: readonly string[];
      readonly sessionIdleMs: number;
      readonly sessionAbsoluteMs: number;
      readonly loginPerSourceLimit: number;
      readonly loginGlobalLimit: number;
      readonly loginWindowMs: number;
      readonly loginConcurrencyLimit: number;
    };

const PREFIX = "KEIKO_FEEDBACK_MAINTAINER_";

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`Missing ${name}`);
  return value;
}

function boundedInteger(env: Environment, name: string, minimum: number, maximum: number): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function exactHttps(value: string, originOnly: boolean): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.href.length > 2_048
  ) {
    throw new Error("Invalid maintainer HTTPS URL");
  }
  if (originOnly && (url.pathname !== "/" || url.search !== "" || url.hash !== "")) {
    throw new Error("Invalid maintainer origin");
  }
  return originOnly ? url.origin : url.href;
}

function boundedPlain(value: string, maximum: number, pattern?: RegExp): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    hasControl(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error("Invalid bounded maintainer identifier");
  }
  return value;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function clientAuthMethod(env: Environment): OidcClientAuthMethod {
  const value = required(env, `${PREFIX}OIDC_CLIENT_AUTH_METHOD`);
  if (value !== "client_secret_basic" && value !== "client_secret_post") {
    throw new Error("Invalid OIDC client authentication method");
  }
  return value;
}

function idTokenAlgorithm(env: Environment): OidcIdTokenAlgorithm {
  const value = required(env, `${PREFIX}OIDC_ID_TOKEN_ALG`);
  if (value !== "RS256" && value !== "PS256" && value !== "ES256") {
    throw new Error("Invalid OIDC ID-token algorithm");
  }
  return value;
}

function issuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href.length > 2_048
  ) {
    throw new Error("Invalid OIDC issuer");
  }
  return url.href;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid maintainer JSON configuration");
  }
}

function permissionRules(env: Environment): readonly MaintainerPermissionRule[] {
  const parsed = parseJson(required(env, `${PREFIX}PERMISSION_RULES_JSON`));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid permission rules");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 32) throw new Error("Invalid permission rules");
  return entries.map(([claimValue, permissions]) => {
    if (boundedPlain(claimValue, 128) !== claimValue || !Array.isArray(permissions)) {
      throw new Error("Invalid permission rule");
    }
    const unique = [...new Set(permissions)];
    if (
      unique.length === 0 ||
      unique.length > 5 ||
      !unique.every(isFeedbackMaintainerPermissionV1)
    ) {
      throw new Error("Invalid permission rule");
    }
    return { claimValue, permissions: unique };
  });
}

function legalHoldKeys(env: Environment): readonly string[] {
  const parsed = parseJson(required(env, `${PREFIX}LEGAL_HOLD_POLICIES_JSON`));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Invalid legal-hold policies");
  }
  if (!isFeedbackLegalHoldPolicyAllowlistV1(parsed)) throw new Error("Invalid legal-hold policies");
  return parsed;
}

function assertNoPartialConfig(env: Environment): void {
  const configured = Object.keys(env).some(
    (name) => name.startsWith(PREFIX) && name !== `${PREFIX}ENABLED`,
  );
  if (configured) throw new Error("Maintainer configuration is disabled but partially configured");
}

export function loadMaintainerRuntimeConfig(env: Environment): MaintainerRuntimeConfig {
  const enabled = env[`${PREFIX}ENABLED`];
  if (enabled !== "true") {
    if (enabled !== undefined && enabled !== "false")
      throw new Error("Invalid maintainer enabled flag");
    assertNoPartialConfig(env);
    return { enabled: false };
  }
  const publicOrigin = exactHttps(required(env, `${PREFIX}PUBLIC_ORIGIN`), true);
  const redirectUri = exactHttps(required(env, `${PREFIX}OIDC_REDIRECT_URI`), false);
  if (redirectUri !== `${publicOrigin}/v1/maintainer/auth/callback`) {
    throw new Error("Invalid maintainer redirect URI");
  }
  const idle = boundedInteger(env, `${PREFIX}SESSION_IDLE_MS`, 60_000, 900_000);
  const absolute = boundedInteger(env, `${PREFIX}SESSION_ABSOLUTE_MS`, idle, 900_000);
  const perSource = boundedInteger(env, `${PREFIX}LOGIN_PER_SOURCE_LIMIT`, 1, 1_000);
  const global = boundedInteger(env, `${PREFIX}LOGIN_GLOBAL_LIMIT`, perSource, 10_000);
  return Object.freeze({
    enabled: true,
    host: required(env, `${PREFIX}HOST`),
    port: boundedInteger(env, `${PREFIX}PORT`, 1, 65_535),
    publicOrigin,
    issuer: issuer(required(env, `${PREFIX}OIDC_ISSUER`)),
    clientId: boundedPlain(required(env, `${PREFIX}OIDC_CLIENT_ID`), 255),
    clientSecretFile: required(env, `${PREFIX}OIDC_CLIENT_SECRET_FILE`),
    clientAuthMethod: clientAuthMethod(env),
    idTokenAlgorithm: idTokenAlgorithm(env),
    redirectUri,
    permissionClaim: boundedPlain(
      required(env, `${PREFIX}PERMISSION_CLAIM`),
      128,
      /^[A-Za-z0-9_.:/-]+$/u,
    ),
    permissionRules: permissionRules(env),
    permissionPolicyVersion: boundedPlain(required(env, `${PREFIX}PERMISSION_POLICY_VERSION`), 64),
    legalHoldPolicyKeys: legalHoldKeys(env),
    sessionIdleMs: idle,
    sessionAbsoluteMs: absolute,
    loginPerSourceLimit: perSource,
    loginGlobalLimit: global,
    loginWindowMs: boundedInteger(env, `${PREFIX}LOGIN_WINDOW_MS`, 1_000, 300_000),
    loginConcurrencyLimit: boundedInteger(env, `${PREFIX}LOGIN_CONCURRENCY_LIMIT`, 1, global),
  });
}
