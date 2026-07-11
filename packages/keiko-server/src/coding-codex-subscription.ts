import {
  CODING_WORKBENCH_CODEX_AUTH_STATUSES,
  CODING_WORKBENCH_CODEX_CREDENTIAL_STORES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexAuthSetupRequest,
  validateCodingWorkbenchCodexSubscriptionProfile,
  type CodingWorkbenchCodexAuthCommandLabel,
  type CodingWorkbenchCodexAuthMethod,
  type CodingWorkbenchCodexAuthSetupPlan,
  type CodingWorkbenchCodexAuthStateRoot,
  type CodingWorkbenchCodexAuthStatus,
  type CodingWorkbenchCodexCredentialStore,
  type CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const MAX_BODY_BYTES = 4096;
const PROFILE_ID = "codex-subscription";
const SUBSCRIPTION_DISABLED_ENV = "KEIKO_CODEX_SUBSCRIPTION_DISABLED";
const CODEX_HEADLESS_ENV = "KEIKO_CODEX_HEADLESS";
const CODEX_AUTH_STATUS_ENV = "KEIKO_CODEX_AUTH_STATUS";
const CODEX_CREDENTIAL_STORE_ENV = "KEIKO_CODEX_CREDENTIAL_STORE";

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function envFlagEnabled(env: EnvSource, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && /^(?:1|true|yes)$/iu.test(value.trim());
}

function credentialStoreForEnv(env: EnvSource): CodingWorkbenchCodexCredentialStore {
  const raw = env[CODEX_CREDENTIAL_STORE_ENV];
  const value = typeof raw === "string" ? raw.trim() : undefined;
  return value !== undefined &&
    (CODING_WORKBENCH_CODEX_CREDENTIAL_STORES as readonly string[]).includes(value)
    ? (value as CodingWorkbenchCodexCredentialStore)
    : "file";
}

function authStatusForEnv(env: EnvSource): CodingWorkbenchCodexAuthStatus {
  if (envFlagEnabled(env, SUBSCRIPTION_DISABLED_ENV)) return "disabled-by-deployment";
  const raw = env[CODEX_AUTH_STATUS_ENV];
  const value = typeof raw === "string" ? raw.trim() : undefined;
  if (
    value !== undefined &&
    (CODING_WORKBENCH_CODEX_AUTH_STATUSES as readonly string[]).includes(value)
  ) {
    return value as CodingWorkbenchCodexAuthStatus;
  }
  return typeof env.CODEX_ACCESS_TOKEN === "string" && env.CODEX_ACCESS_TOKEN.trim().length > 0
    ? "connected"
    : "missing";
}

function authMethodForStatus(
  status: CodingWorkbenchCodexAuthStatus,
  env: EnvSource,
): CodingWorkbenchCodexAuthMethod | undefined {
  if (status !== "connected") return undefined;
  return typeof env.CODEX_ACCESS_TOKEN === "string" && env.CODEX_ACCESS_TOKEN.trim().length > 0
    ? "codex-access-token"
    : undefined;
}

function isHeadless(env: EnvSource): boolean {
  return envFlagEnabled(env, CODEX_HEADLESS_ENV) || envFlagEnabled(env, "CI");
}

function stateScopeForStore(
  credentialStore: CodingWorkbenchCodexCredentialStore,
): CodingWorkbenchCodexSubscriptionProfile["stateScope"] {
  return credentialStore === "keyring" ? "os-credential-store" : "keiko-owned-state";
}

function stateRootForStore(
  credentialStore: CodingWorkbenchCodexCredentialStore,
): CodingWorkbenchCodexAuthStateRoot {
  return credentialStore === "keyring" ? "os-credential-store" : "keiko-codex-runtime-state";
}

export function codexSubscriptionProfileForEnv(
  env: EnvSource,
): CodingWorkbenchCodexSubscriptionProfile {
  const credentialStore = credentialStoreForEnv(env);
  const status = authStatusForEnv(env);
  const headless = isHeadless(env);
  const authMethod = authMethodForStatus(status, env);
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status,
    ...(authMethod === undefined ? {} : { authMethod }),
    credentialStore,
    stateScope: stateScopeForStore(credentialStore),
    stateRoot: stateRootForStore(credentialStore),
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: !headless,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: status === "disabled-by-deployment",
    headless,
  };
}

function commandLabelFor(
  method: CodingWorkbenchCodexAuthMethod,
): CodingWorkbenchCodexAuthCommandLabel {
  if (method === "chatgpt-browser-login") return "codex-login";
  if (method === "chatgpt-device-code") return "codex-login-device-auth";
  return "codex-login-with-access-token";
}

function setupPlanFor(
  method: CodingWorkbenchCodexAuthMethod,
  env: EnvSource,
): CodingWorkbenchCodexAuthSetupPlan {
  const credentialStore = credentialStoreForEnv(env);
  const accessToken = method === "codex-access-token";
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    method,
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    credentialStore,
    stateScope: stateScopeForStore(credentialStore),
    stateRoot: stateRootForStore(credentialStore),
    usesGlobalCodexHome: false,
    commandLabel: commandLabelFor(method),
    requiresSecretInput: accessToken,
    ...(accessToken ? { credentialTransport: "stdin" as const } : {}),
  };
}

function readBody(req: RouteContext["req"]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new BodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJson(req: RouteContext["req"]): Promise<unknown> {
  const body = await readBody(req);
  return body.trim().length === 0 ? {} : JSON.parse(body);
}

function invalidSetupRequest(): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "Codex subscription setup request is invalid."),
  };
}

function blockedSetup(message: string): RouteResult {
  return {
    status: 409,
    body: errorBody("CODEX_SUBSCRIPTION_UNAVAILABLE", message),
  };
}

export function handleCodingCodexSubscriptionProfile(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const profile = codexSubscriptionProfileForEnv(deps.env);
  const parsed = validateCodingWorkbenchCodexSubscriptionProfile(profile);
  return {
    status: parsed.ok ? 200 : 500,
    body: parsed.ok
      ? parsed.value
      : errorBody("INTERNAL", "Codex subscription profile validation failed."),
  };
}

export async function handleCodingCodexSubscriptionSetup(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const parsed = validateCodingWorkbenchCodexAuthSetupRequest(await readJson(ctx.req));
    if (!parsed.ok) return invalidSetupRequest();
    if (envFlagEnabled(deps.env, SUBSCRIPTION_DISABLED_ENV)) {
      return blockedSetup("Codex subscription login is disabled by deployment policy.");
    }
    if (parsed.value.method === "chatgpt-browser-login" && isHeadless(deps.env)) {
      return blockedSetup("Codex subscription browser login is unavailable in this environment.");
    }
    const plan = setupPlanFor(parsed.value.method, deps.env);
    const validPlan = validateCodingWorkbenchCodexAuthSetupPlan(plan);
    return validPlan.ok ? { status: 200, body: validPlan.value } : invalidSetupRequest();
  } catch {
    return invalidSetupRequest();
  }
}
