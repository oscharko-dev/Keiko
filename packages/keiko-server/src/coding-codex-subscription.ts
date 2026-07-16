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
import { createHash, randomUUID } from "node:crypto";
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
const MAX_AUTH_NAVIGATION_INTENT_TTL_MS = 60_000;
const DEFAULT_AUTH_NAVIGATION_INTENT_CAPACITY = 16;
const MAX_AUTH_NAVIGATION_INTENT_CAPACITY = 32;

export interface CodexSubscriptionProfileCoordinatorDeps {
  readonly probe: (signal: AbortSignal) => Promise<unknown>;
  readonly now: () => number;
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly setTimeout: (callback: () => void, delayMs: number) => object | number;
  readonly clearTimeout: (handle: object | number) => void;
}

export interface CodexSubscriptionProfileCoordinator {
  readonly getProfile: () => Promise<CodingWorkbenchCodexSubscriptionProfile>;
  readonly loginStarted: () => void;
  readonly browserLoginStarted: () => void;
  readonly deviceCodeLoginStarted: () => void;
  readonly loginCancelled: () => void;
  readonly loginCompleted: () => void;
  readonly loginSucceeded: () => void;
  readonly loginFailed: () => void;
  readonly loginExpired: () => void;
  readonly loginRevoked: () => void;
  readonly loginClosed: (outcome: CodexSubscriptionAuthClosedOutcome) => void;
  readonly logout: () => void;
}

export type CodexSubscriptionAuthClosedOutcome = "cancelled" | "expired" | "failed" | "revoked";

export interface CodexAuthNavigationIntent {
  readonly nonce: string;
}

export interface CodexAuthNavigationIntentCoordinatorDeps {
  readonly now: () => number;
  readonly ttlMs: number;
  readonly maxIntents: number;
  readonly newNonce: () => string;
  readonly sha256: (value: string) => string;
  readonly setTimeout: (callback: () => void, delayMs: number) => object | number;
  readonly clearTimeout: (handle: object | number) => void;
}

export interface CodexAuthNavigationIntentCoordinator {
  readonly create: (input: CodexAuthNavigationIntentInput) => CodexAuthNavigationIntent | undefined;
  readonly consume: (input: CodexAuthNavigationIntentConsumption) => string | undefined;
  readonly invalidateLogin: (runId: string, loginId: string) => void;
  readonly invalidateRun: (runId: string) => void;
  readonly dispose: () => void;
}

export interface CodexAuthNavigationIntentInput {
  readonly url: string;
  readonly runId: string;
  readonly loginId: string;
}

export interface CodexAuthNavigationIntentConsumption {
  readonly nonce: string;
  readonly runId: string;
  readonly loginId: string;
}

interface StoredCodexAuthNavigationIntent {
  readonly url: string;
  readonly urlDigest: string;
  readonly runId: string;
  readonly loginId: string;
  readonly expiresAt: number;
}

interface CachedProfile {
  readonly expiresAt: number;
  readonly value: CodingWorkbenchCodexSubscriptionProfile;
}

interface InFlightProfile {
  readonly promise: Promise<CodingWorkbenchCodexSubscriptionProfile>;
}

interface ResolvedProfile {
  readonly profile: CodingWorkbenchCodexSubscriptionProfile;
  readonly cacheable: boolean;
}

export function isCodexAuthNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "auth.openai.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function createCodexAuthNavigationIntentCoordinator(
  deps: Partial<CodexAuthNavigationIntentCoordinatorDeps> = {},
): CodexAuthNavigationIntentCoordinator {
  const configured = navigationIntentDeps(deps);
  const intents = new Map<string, StoredCodexAuthNavigationIntent>();
  const timers = new Map<string, object | number>();
  return {
    create: (input): CodexAuthNavigationIntent | undefined =>
      createNavigationIntent(input, intents, timers, configured),
    consume: (input): string | undefined =>
      consumeNavigationIntent(input, intents, timers, configured),
    invalidateLogin: (runId, loginId): void => {
      invalidateIntents(
        intents,
        timers,
        configured,
        (intent): boolean => intent.runId === runId && intent.loginId === loginId,
      );
    },
    invalidateRun: (runId): void => {
      invalidateIntents(intents, timers, configured, (intent): boolean => intent.runId === runId);
    },
    dispose: (): void => {
      for (const nonce of intents.keys()) removeIntent(nonce, intents, timers, configured);
    },
  };
}

function createNavigationIntent(
  input: CodexAuthNavigationIntentInput,
  intents: Map<string, StoredCodexAuthNavigationIntent>,
  timers: Map<string, object | number>,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
): CodexAuthNavigationIntent | undefined {
  clearExpiredIntents(intents, timers, deps);
  const created = storedNavigationIntent(input, deps);
  if (created === undefined || intents.has(created.nonce) || intents.size >= deps.maxIntents) {
    return undefined;
  }
  intents.set(created.nonce, created.intent);
  timers.set(
    created.nonce,
    deps.setTimeout(
      (): void => {
        removeIntent(created.nonce, intents, timers, deps);
      },
      Math.max(0, created.intent.expiresAt - deps.now()),
    ),
  );
  return Object.freeze({ nonce: created.nonce });
}

function consumeNavigationIntent(
  input: CodexAuthNavigationIntentConsumption,
  intents: Map<string, StoredCodexAuthNavigationIntent>,
  timers: Map<string, object | number>,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
): string | undefined {
  clearExpiredIntents(intents, timers, deps);
  const stored = intents.get(input.nonce);
  if (stored === undefined || !matchesNavigationIntent(stored, input, deps)) return undefined;
  removeIntent(input.nonce, intents, timers, deps);
  return stored.url;
}

function clearExpiredIntents(
  intents: Map<string, StoredCodexAuthNavigationIntent>,
  timers: Map<string, object | number>,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
): void {
  for (const [nonce, intent] of intents) {
    if (intent.expiresAt <= deps.now()) removeIntent(nonce, intents, timers, deps);
  }
}

function invalidateIntents(
  intents: Map<string, StoredCodexAuthNavigationIntent>,
  timers: Map<string, object | number>,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
  matches: (intent: StoredCodexAuthNavigationIntent) => boolean,
): void {
  for (const [nonce, intent] of intents) {
    if (matches(intent)) removeIntent(nonce, intents, timers, deps);
  }
}

function removeIntent(
  nonce: string,
  intents: Map<string, StoredCodexAuthNavigationIntent>,
  timers: Map<string, object | number>,
  deps: Pick<CodexAuthNavigationIntentCoordinatorDeps, "clearTimeout">,
): void {
  const timer = timers.get(nonce);
  if (timer !== undefined) deps.clearTimeout(timer);
  timers.delete(nonce);
  intents.delete(nonce);
}

function storedNavigationIntent(
  input: CodexAuthNavigationIntentInput,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
): { readonly nonce: string; readonly intent: StoredCodexAuthNavigationIntent } | undefined {
  if (!isCodexAuthNavigationUrl(input.url) || !nonEmpty(input.runId) || !nonEmpty(input.loginId)) {
    return undefined;
  }
  const nonce = deps.newNonce();
  if (!nonEmpty(nonce)) return undefined;
  return {
    nonce,
    intent: {
      url: input.url,
      urlDigest: deps.sha256(input.url),
      runId: input.runId,
      loginId: input.loginId,
      expiresAt: deps.now() + Math.max(0, deps.ttlMs),
    },
  };
}

function matchesNavigationIntent(
  stored: StoredCodexAuthNavigationIntent,
  input: CodexAuthNavigationIntentConsumption,
  deps: CodexAuthNavigationIntentCoordinatorDeps,
): boolean {
  return (
    stored.runId === input.runId &&
    stored.loginId === input.loginId &&
    isCodexAuthNavigationUrl(stored.url) &&
    stored.urlDigest === deps.sha256(stored.url)
  );
}

function navigationIntentDeps(
  deps: Partial<CodexAuthNavigationIntentCoordinatorDeps>,
): CodexAuthNavigationIntentCoordinatorDeps {
  return {
    now: deps.now ?? Date.now,
    ttlMs: Math.min(
      Math.max(0, deps.ttlMs ?? MAX_AUTH_NAVIGATION_INTENT_TTL_MS),
      MAX_AUTH_NAVIGATION_INTENT_TTL_MS,
    ),
    maxIntents: Math.min(
      Math.max(1, deps.maxIntents ?? DEFAULT_AUTH_NAVIGATION_INTENT_CAPACITY),
      MAX_AUTH_NAVIGATION_INTENT_CAPACITY,
    ),
    newNonce: deps.newNonce ?? randomUUID,
    sha256: deps.sha256 ?? sha256,
    setTimeout: deps.setTimeout ?? setTimeout,
    clearTimeout:
      deps.clearTimeout ??
      ((handle): void => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

export function createCodexSubscriptionProfileCoordinator(
  deps: CodexSubscriptionProfileCoordinatorDeps,
): CodexSubscriptionProfileCoordinator {
  let cache: CachedProfile | undefined;
  let inFlight: InFlightProfile | undefined;
  let generation = 0;
  const invalidate = (): void => {
    generation += 1;
    cache = undefined;
    inFlight = undefined;
  };
  return {
    getProfile: (): Promise<CodingWorkbenchCodexSubscriptionProfile> => {
      const cached = cache;
      if (cached !== undefined && cached.expiresAt > deps.now())
        return Promise.resolve(cached.value);
      if (inFlight !== undefined) return inFlight.promise;
      const requestGeneration = generation;
      const promise = resolveProfile(deps, (): boolean => generation === requestGeneration)
        .then((resolved) => {
          if (generation !== requestGeneration) return unavailableProfile();
          if (resolved.cacheable) {
            cache = {
              expiresAt: deps.now() + Math.max(0, deps.ttlMs),
              value: resolved.profile,
            };
          }
          return resolved.profile;
        })
        .finally(() => {
          if (inFlight?.promise === promise) inFlight = undefined;
        });
      inFlight = { promise };
      return promise;
    },
    loginStarted: invalidate,
    browserLoginStarted: invalidate,
    deviceCodeLoginStarted: invalidate,
    loginCancelled: invalidate,
    loginCompleted: invalidate,
    loginSucceeded: invalidate,
    loginFailed: invalidate,
    loginExpired: invalidate,
    loginRevoked: invalidate,
    loginClosed: invalidate,
    logout: invalidate,
  };
}

async function resolveProfile(
  deps: CodexSubscriptionProfileCoordinatorDeps,
  current: () => boolean,
): Promise<ResolvedProfile> {
  const controller = new AbortController();
  try {
    const value = await withinDeadline(
      Promise.resolve().then((): Promise<unknown> => deps.probe(controller.signal)),
      controller,
      deps,
    );
    if (!current()) return { profile: unavailableProfile(), cacheable: false };
    const validated = validateCodingWorkbenchCodexSubscriptionProfile(value);
    return validated.ok
      ? { profile: closedProfile(validated.value), cacheable: true }
      : { profile: unavailableProfile(), cacheable: false };
  } catch {
    return { profile: unavailableProfile(), cacheable: false };
  }
}

function withinDeadline<T>(
  promise: Promise<T>,
  controller: AbortController,
  deps: Pick<CodexSubscriptionProfileCoordinatorDeps, "timeoutMs" | "setTimeout" | "clearTimeout">,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = deps.setTimeout(
      (): void => {
        controller.abort();
        reject(new Error("probe-timeout"));
      },
      Math.max(0, deps.timeoutMs),
    );
    promise.then(
      (value) => {
        deps.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        deps.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("probe-failed"));
      },
    );
  });
}

function unavailableProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return closedProfile({
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "failed-login",
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  });
}

function closedProfile(
  profile: CodingWorkbenchCodexSubscriptionProfile,
): CodingWorkbenchCodexSubscriptionProfile {
  return Object.freeze({
    ...profile,
    ...(profile.authMethod === undefined ? {} : { authMethod: profile.authMethod }),
    runtimeBinarySources: Object.freeze([...profile.runtimeBinarySources]),
  });
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
  runtimeApprovedVerified = false,
): CodingWorkbenchCodexSubscriptionProfile {
  const credentialStore = credentialStoreForEnv(env);
  const status = runtimeApprovedVerified ? authStatusForEnv(env) : "redistribution-unapproved";
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
    runtimeBinarySources: runtimeApprovedVerified ? ["managed-sidecar-runtime"] : [],
    supportsBrowserLogin: runtimeApprovedVerified && !headless,
    supportsDeviceCode: runtimeApprovedVerified,
    supportsAccessToken: runtimeApprovedVerified,
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

function redistributionUnapproved(): RouteResult {
  return {
    status: 409,
    body: {
      ...errorBody("CODEX_SUBSCRIPTION_UNAVAILABLE", "Codex runtime is unavailable."),
      status: "redistribution-unapproved",
      reasonCode: "redistribution-unapproved",
      codexSubscriptionAllowed: false,
      runtimeBinarySources: [],
      setupMethods: [],
    },
  };
}

export async function handleCodingCodexSubscriptionProfile(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const approved = deps.codexRuntimeAvailability?.isApprovedVerified() === true;
  const environmentProfile = codexSubscriptionProfileForEnv(deps.env, approved);
  if (
    approved &&
    !environmentProfile.deploymentPolicyDisabled &&
    deps.codexSubscriptionProfileCoordinator !== undefined
  ) {
    return profileRouteResult(await deps.codexSubscriptionProfileCoordinator.getProfile());
  }
  return profileRouteResult(environmentProfile);
}

function profileRouteResult(profile: unknown): RouteResult {
  const parsed = validateCodingWorkbenchCodexSubscriptionProfile(profile);
  return {
    status: parsed.ok ? 200 : 500,
    body: parsed.ok
      ? parsed.value
      : errorBody("INTERNAL", "Codex subscription profile validation failed."),
  };
}

function invalidateForSetup(
  method: CodingWorkbenchCodexAuthMethod,
  coordinator: CodexSubscriptionProfileCoordinator | undefined,
): void {
  if (method === "chatgpt-browser-login") {
    coordinator?.browserLoginStarted();
  } else if (method === "chatgpt-device-code") {
    coordinator?.deviceCodeLoginStarted();
  } else {
    coordinator?.loginStarted();
  }
}

export async function handleCodingCodexSubscriptionSetup(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const parsed = validateCodingWorkbenchCodexAuthSetupRequest(await readJson(ctx.req));
    if (!parsed.ok) return invalidSetupRequest();
    if (deps.codexRuntimeAvailability?.isApprovedVerified() !== true) {
      return redistributionUnapproved();
    }
    if (envFlagEnabled(deps.env, SUBSCRIPTION_DISABLED_ENV)) {
      return blockedSetup("Codex subscription login is disabled by deployment policy.");
    }
    if (parsed.value.method === "chatgpt-browser-login" && isHeadless(deps.env)) {
      return blockedSetup("Codex subscription browser login is unavailable in this environment.");
    }
    const plan = setupPlanFor(parsed.value.method, deps.env);
    const validPlan = validateCodingWorkbenchCodexAuthSetupPlan(plan);
    if (!validPlan.ok) return invalidSetupRequest();
    invalidateForSetup(parsed.value.method, deps.codexSubscriptionProfileCoordinator);
    return { status: 200, body: validPlan.value };
  } catch {
    return invalidSetupRequest();
  }
}
