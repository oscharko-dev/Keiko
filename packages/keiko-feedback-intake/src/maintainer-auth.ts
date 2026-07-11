import type { FeedbackMaintainerPermissionV1 } from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import type { MaintainerRuntimeConfig } from "./maintainer-config.js";
import type { MaintainerOidcClient } from "./maintainer-oidc.js";
import {
  PostgresMaintainerAuthStore,
  type CreatedMaintainerSession,
  type MaintainerSessionIdentity,
} from "./maintainer-store.js";

type EnabledConfig = Extract<MaintainerRuntimeConfig, { readonly enabled: true }>;
type AuthStore = Pick<
  PostgresMaintainerAuthStore,
  "createTransaction" | "consumeTransaction" | "createSession" | "session" | "revoke"
>;

export interface MaintainerAuthService {
  login(): Promise<{ readonly url: URL; readonly browserCapability: string }>;
  callback(
    url: URL,
    browserCapability: string,
    existingCapability?: string,
  ): Promise<CreatedMaintainerSession>;
  session(capability: string): Promise<MaintainerSessionIdentity | undefined>;
  logout(capability: string): Promise<void>;
}

export class MaintainerAuthError extends Error {
  constructor(readonly code: "invalid-callback" | "authorization-denied") {
    super(code === "invalid-callback" ? "OIDC callback failed" : "OIDC authorization denied");
    this.name = "MaintainerAuthError";
  }
}

function claimValues(value: unknown): readonly string[] {
  if (typeof value === "string") return value.length <= 128 ? [value] : [];
  if (!Array.isArray(value) || value.length > 32) return [];
  if (!value.every((item) => typeof item === "string" && item.length <= 128)) return [];
  return value as string[];
}

function resolvePermissions(
  config: EnabledConfig,
  claims: Readonly<Record<string, unknown>>,
): readonly FeedbackMaintainerPermissionV1[] {
  const values = new Set(claimValues(claims[config.permissionClaim]));
  const permissions = config.permissionRules.flatMap((rule) =>
    values.has(rule.claimValue) ? rule.permissions : [],
  );
  return [...new Set(permissions)].sort();
}

export function createMaintainerAuthService(
  config: EnabledConfig,
  oidc: MaintainerOidcClient,
  store: AuthStore,
  now: () => Date = () => new Date(),
): MaintainerAuthService {
  return {
    login: async (): Promise<{ readonly url: URL; readonly browserCapability: string }> => {
      const transaction = await oidc.begin();
      const browserCapability = await store.createTransaction(
        transaction.state,
        transaction.nonce,
        transaction.verifier,
        config.redirectUri,
        now(),
      );
      return { url: transaction.authorizationUrl, browserCapability };
    },
    callback: async (
      url,
      browserCapability,
      existingCapability,
    ): Promise<CreatedMaintainerSession> => {
      const state = url.searchParams.get("state");
      if (state === null || state.length > 256) {
        throw new MaintainerAuthError("invalid-callback");
      }
      const transaction = await store.consumeTransaction(state, browserCapability, now());
      if (transaction === undefined) throw new MaintainerAuthError("invalid-callback");
      const identity = await oidc.exchange(url, transaction);
      if (identity.issuer !== config.issuer) throw new MaintainerAuthError("invalid-callback");
      const permissions = resolvePermissions(config, identity.claims);
      if (permissions.length === 0) throw new MaintainerAuthError("authorization-denied");
      if (existingCapability !== undefined) await store.revoke(existingCapability, now());
      return store.createSession(
        identity.issuer,
        identity.subject,
        permissions,
        config.permissionPolicyVersion,
        now(),
      );
    },
    session: (capability) => store.session(capability, config.permissionPolicyVersion, now()),
    logout: (capability) => store.revoke(capability, now()),
  };
}
