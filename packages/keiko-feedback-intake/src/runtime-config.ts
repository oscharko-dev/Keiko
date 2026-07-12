import { validateIntakeLimits } from "./config.js";
import { DAY_MS, type IntakeLimits } from "./types.js";
import { canonicalTrustedCidrs } from "./proxy.js";
import {
  loadGithubAppConfig,
  type GithubAppConfig,
  type GithubAppOperatorInput,
} from "./github-app-config.js";

export type GithubPublicationRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly github: GithubAppConfig;
      readonly maxConcurrentDeliveries: number;
      readonly pollIntervalMs: number;
      readonly leaseDurationMs: number;
      readonly circuitCooldownMs: number;
    };

export interface HostedRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly limits: IntakeLimits;
  readonly proxyFamily: "forwarded" | "x-forwarded-for";
  readonly trustedProxyCidrs: readonly string[];
  readonly secretDirectory: string;
  readonly managementHost: "127.0.0.1" | "::1";
  readonly managementPort: number;
  readonly drainDeadlineMs: number;
  readonly retentionIntervalMs: number;
  readonly publication: GithubPublicationRuntimeConfig;
}

type Environment = Readonly<Record<string, string | undefined>>;

const LIMIT_NAMES = {
  perIdentity: "KEIKO_FEEDBACK_PER_IDENTITY_LIMIT",
  global: "KEIKO_FEEDBACK_GLOBAL_LIMIT",
  concurrency: "KEIKO_FEEDBACK_CONCURRENCY_LIMIT",
  receiptConcurrency: "KEIKO_FEEDBACK_RECEIPT_CONCURRENCY_LIMIT",
  openPayloadCount: "KEIKO_FEEDBACK_OPEN_COUNT_LIMIT",
  openPayloadBytes: "KEIKO_FEEDBACK_OPEN_BYTES_LIMIT",
  proxyHops: "KEIKO_FEEDBACK_PROXY_HOPS_LIMIT",
  bodyBytes: "KEIKO_FEEDBACK_BODY_BYTES_LIMIT",
  headerBytes: "KEIKO_FEEDBACK_HEADER_BYTES_LIMIT",
  bodyDeadlineMs: "KEIKO_FEEDBACK_BODY_DEADLINE_MS",
  storageDeadlineMs: "KEIKO_FEEDBACK_STORAGE_DEADLINE_MS",
} as const;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`Missing ${name}`);
  return value;
}

function finite(env: Environment, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

function bounded(env: Environment, name: string, minimum: number, maximum: number): number {
  const value = finite(env, name);
  if (value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function proxyFamily(env: Environment): HostedRuntimeConfig["proxyFamily"] {
  const family = required(env, "KEIKO_FEEDBACK_PROXY_FAMILY");
  if (family !== "forwarded" && family !== "x-forwarded-for") {
    throw new Error("Invalid proxy family");
  }
  return family;
}

function managementHost(env: Environment): HostedRuntimeConfig["managementHost"] {
  const host = required(env, "KEIKO_FEEDBACK_MANAGEMENT_HOST");
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Invalid management host");
  return host;
}

function databaseUrl(env: Environment): string {
  const value = required(env, "DATABASE_URL");
  if (!/^postgres(?:ql)?:\/\//u.test(value)) throw new Error("Invalid DATABASE_URL");
  return value;
}

function cidrs(env: Environment): readonly string[] {
  const value = env.KEIKO_FEEDBACK_TRUSTED_PROXY_CIDRS;
  if (value === undefined || value === "") return [];
  const result = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (result.length > 32) throw new Error("Invalid KEIKO_FEEDBACK_TRUSTED_PROXY_CIDRS");
  return canonicalTrustedCidrs(result);
}

function optionalBounded(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return env[name] === undefined ? fallback : bounded(env, name, minimum, maximum);
}

function githubInput(env: Environment): GithubAppOperatorInput {
  return {
    ...(env.KEIKO_FEEDBACK_GITHUB_APP_ID === undefined
      ? {}
      : { appId: env.KEIKO_FEEDBACK_GITHUB_APP_ID }),
    ...(env.KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_FILE === undefined
      ? {}
      : { privateKeyFile: env.KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_FILE }),
    ...(env.KEIKO_FEEDBACK_GITHUB_TARGETS_POLICY_FILE === undefined
      ? {}
      : { targetsPolicyFile: env.KEIKO_FEEDBACK_GITHUB_TARGETS_POLICY_FILE }),
    ...(env.KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_ROTATED_AT === undefined
      ? {}
      : { privateKeyRotatedAt: env.KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_ROTATED_AT }),
  };
}

function publication(env: Environment, now: Date): GithubPublicationRuntimeConfig {
  const readiness = loadGithubAppConfig(githubInput(env), now);
  if (readiness.status === "disabled") {
    const tuningPresent = [
      "KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES",
      "KEIKO_FEEDBACK_GITHUB_POLL_INTERVAL_MS",
      "KEIKO_FEEDBACK_GITHUB_LEASE_DURATION_MS",
      "KEIKO_FEEDBACK_GITHUB_CIRCUIT_COOLDOWN_MS",
    ].some((name) => env[name] !== undefined);
    if (tuningPresent) throw new Error("Invalid GitHub publication configuration");
    return Object.freeze({ enabled: false });
  }
  if (readiness.status === "invalid") throw new Error("Invalid GitHub publication configuration");
  return Object.freeze({
    enabled: true,
    github: readiness.config,
    maxConcurrentDeliveries: optionalBounded(
      env,
      "KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES",
      4,
      1,
      32,
    ),
    pollIntervalMs: optionalBounded(
      env,
      "KEIKO_FEEDBACK_GITHUB_POLL_INTERVAL_MS",
      1_000,
      100,
      30_000,
    ),
    leaseDurationMs: optionalBounded(
      env,
      "KEIKO_FEEDBACK_GITHUB_LEASE_DURATION_MS",
      60_000,
      5_000,
      300_000,
    ),
    circuitCooldownMs: optionalBounded(
      env,
      "KEIKO_FEEDBACK_GITHUB_CIRCUIT_COOLDOWN_MS",
      30_000,
      1_000,
      3_600_000,
    ),
  });
}

export function loadHostedRuntimeConfig(env: Environment, now = new Date()): HostedRuntimeConfig {
  const limits = Object.fromEntries(
    Object.entries(LIMIT_NAMES).map(([key, name]) => [key, finite(env, name)]),
  ) as unknown as IntakeLimits;
  const port = bounded(env, "KEIKO_FEEDBACK_PORT", 1, 65_535);
  const managementPort = bounded(env, "KEIKO_FEEDBACK_MANAGEMENT_PORT", 1, 65_535);
  if (managementPort === port) throw new Error("Invalid management port");
  return Object.freeze({
    host: required(env, "KEIKO_FEEDBACK_HOST"),
    port,
    databaseUrl: databaseUrl(env),
    limits: validateIntakeLimits(limits),
    proxyFamily: proxyFamily(env),
    trustedProxyCidrs: cidrs(env),
    secretDirectory: required(env, "KEIKO_FEEDBACK_SECRET_DIR"),
    managementHost: managementHost(env),
    managementPort,
    drainDeadlineMs: bounded(env, "KEIKO_FEEDBACK_DRAIN_DEADLINE_MS", 100, 30_000),
    retentionIntervalMs: bounded(env, "KEIKO_FEEDBACK_RETENTION_INTERVAL_MS", 1_000, DAY_MS),
    publication: publication(env, now),
  });
}
