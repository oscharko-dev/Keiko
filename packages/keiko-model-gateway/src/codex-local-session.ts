import { spawnSync } from "node:child_process";
import {
  AuthenticationError,
  ConfigInvalidError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { normalizeApiKeyHeaderName, validateBaseUrl } from "./config.js";
import type {
  OpenAiCodexLocalSessionProviderConfig,
  OpenAiCodexLocalSessionRuntimeProviderConfig,
} from "./types.js";

const CONFIGURED_CODEX_CLI = process.env.KEIKO_CODEX_CLI_PATH?.trim();
const DEFAULT_CODEX_CLI = CONFIGURED_CODEX_CLI && CONFIGURED_CODEX_CLI.length > 0
  ? CONFIGURED_CODEX_CLI
  : "codex";
const DEFAULT_STATUS_ARGS = Object.freeze(["auth", "status", "--json"]);
const DEFAULT_VERSION_ARGS = Object.freeze(["--version"]);
const MINIMUM_CODEX_CLI_VERSION = "26.602.0";
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

export interface CodexLocalSessionCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorCode?: string | undefined;
}

export interface CodexLocalSessionCommandRunner {
  readonly run: (args: readonly string[]) => CodexLocalSessionCommandResult;
}

export interface CodexLocalSessionResolverDeps {
  readonly commandRunner?: CodexLocalSessionCommandRunner | undefined;
  readonly minimumVersion?: string | undefined;
}

export type CodexLocalSessionRuntimeResolver = (
  provider: OpenAiCodexLocalSessionProviderConfig,
) => OpenAiCodexLocalSessionRuntimeProviderConfig;

type CodexSessionState = "authenticated" | "missing" | "expired";

interface CodexSessionStatus {
  readonly state: CodexSessionState;
  readonly expiresAt: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normaliseSessionState(value: unknown): CodexSessionState | undefined {
  const state = asString(value)?.toLowerCase();
  if (state === undefined) {
    return undefined;
  }
  if (["authenticated", "ready", "ok", "active"].includes(state)) {
    return "authenticated";
  }
  if (["missing", "unauthenticated", "logged-out", "logged_out"].includes(state)) {
    return "missing";
  }
  if (["expired", "stale"].includes(state)) {
    return "expired";
  }
  return undefined;
}

function parseJson(label: string, raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new ConfigInvalidError(`${label} returned malformed JSON`);
  }
}

function parseVersionToken(stdout: string): string | undefined {
  return /\d+(?:\.\d+)+/u.exec(stdout)?.[0];
}

function parseVersionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const l = leftParts[index] ?? 0;
    const r = rightParts[index] ?? 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

function commandFailure(label: string, result: CodexLocalSessionCommandResult): never {
  if (result.errorCode === "ENOENT") {
    throw new ConfigInvalidError("codex local session requires the codex CLI, but it is not installed");
  }
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes("expired")) {
    throw new AuthenticationError("codex local session has expired");
  }
  if (
    stderr.includes("login") ||
    stderr.includes("logged in") ||
    stderr.includes("logged-in") ||
    stderr.includes("session")
  ) {
    throw new AuthenticationError("codex local session is not signed in");
  }
  throw new ConfigInvalidError(`${label} failed`);
}

function parseVersion(
  minimumVersion: string,
  result: CodexLocalSessionCommandResult,
): string {
  if (result.exitCode !== 0) {
    return commandFailure("codex local session version check", result);
  }
  const version = parseVersionToken(result.stdout);
  if (version === undefined) {
    throw new ConfigInvalidError("codex local session version check returned an unreadable version");
  }
  if (compareVersions(version, minimumVersion) < 0) {
    throw new ConfigInvalidError(
      `codex local session requires codex CLI ${minimumVersion} or newer`,
    );
  }
  return version;
}

function resolveState(payload: JsonRecord): CodexSessionState {
  const session = asRecord(payload.session);
  const topLevel = normaliseSessionState(payload.state);
  const nested = normaliseSessionState(session?.state);
  const authenticated = asBoolean(payload.authenticated) ?? asBoolean(session?.authenticated);
  if (authenticated === true) {
    return "authenticated";
  }
  if (authenticated === false) {
    return nested ?? topLevel ?? "missing";
  }
  return nested ?? topLevel ?? "missing";
}

function resolveExpiresAt(payload: JsonRecord): string | null {
  const session = asRecord(payload.session);
  return asString(session?.expiresAt) ?? asString(payload.expiresAt) ?? null;
}

function resolveBaseUrl(payload: JsonRecord): string {
  const endpoint = asRecord(payload.endpoint);
  const baseUrl = asString(endpoint?.baseUrl) ?? asString(payload.baseUrl);
  if (baseUrl === undefined) {
    throw new ConfigInvalidError("codex local session status did not include a runtime baseUrl");
  }
  validateBaseUrl(baseUrl, "codexLocalSession");
  return baseUrl;
}

function resolveApiKeyHeaderName(payload: JsonRecord): string {
  const endpoint = asRecord(payload.endpoint);
  const headerName =
    asString(endpoint?.apiKeyHeaderName) ??
    asString(endpoint?.headerName) ??
    asString(payload.apiKeyHeaderName) ??
    "authorization";
  return normalizeApiKeyHeaderName(headerName, "codexLocalSession.apiKeyHeaderName");
}

function resolveApiKey(payload: JsonRecord): string {
  const credentials = asRecord(payload.credentials);
  const session = asRecord(payload.session);
  const candidates = [
    asString(credentials?.apiKey),
    asString(credentials?.token),
    asString(payload.apiKey),
    asString(payload.accessToken),
    asString(session?.apiKey),
    asString(session?.token),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  throw new ConfigInvalidError("codex local session status did not include runtime credentials");
}

function assertSupportedCapabilities(payload: JsonRecord): void {
  const capabilities = asRecord(payload.capabilities);
  if (capabilities === undefined) {
    throw new ConfigInvalidError("codex local session status did not include capability metadata");
  }
  if (capabilities.chatCompletions !== true) {
    throw new ConfigInvalidError(
      "codex local session does not expose the required chatCompletions capability",
    );
  }
  if (capabilities.workflow !== true) {
    throw new ConfigInvalidError(
      "codex local session does not expose the required workflow capability",
    );
  }
}

function parseStatus(
  result: CodexLocalSessionCommandResult,
  now: number,
): CodexSessionStatus {
  if (result.exitCode !== 0) {
    return commandFailure("codex local session status check", result);
  }
  const payload = parseJson("codex local session status", result.stdout);
  const state = resolveState(payload);
  const expiresAt = resolveExpiresAt(payload);
  if (state === "missing") {
    throw new AuthenticationError("codex local session is not signed in");
  }
  if (state === "expired") {
    throw new AuthenticationError(
      expiresAt === null
        ? "codex local session has expired"
        : `codex local session expired at ${expiresAt}`,
    );
  }
  if (expiresAt !== null) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= now) {
      throw new AuthenticationError(`codex local session expired at ${expiresAt}`);
    }
  }
  assertSupportedCapabilities(payload);
  return {
    state,
    expiresAt,
    baseUrl: resolveBaseUrl(payload),
    apiKey: resolveApiKey(payload),
    apiKeyHeaderName: resolveApiKeyHeaderName(payload),
  };
}

export function createDefaultCodexLocalSessionCommandRunner(
  executable = DEFAULT_CODEX_CLI,
): CodexLocalSessionCommandRunner {
  return {
    run: (args): CodexLocalSessionCommandResult => {
      const result = spawnSync(executable, args, {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: DEFAULT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
      };
    },
  };
}

export function createCodexLocalSessionRuntimeResolver(
  deps: CodexLocalSessionResolverDeps = {},
): CodexLocalSessionRuntimeResolver {
  const commandRunner =
    deps.commandRunner ?? createDefaultCodexLocalSessionCommandRunner(DEFAULT_CODEX_CLI);
  const minimumVersion = deps.minimumVersion ?? MINIMUM_CODEX_CLI_VERSION;
  return (provider) => {
    const versionResult = commandRunner.run(DEFAULT_VERSION_ARGS);
    parseVersion(minimumVersion, versionResult);
    const statusResult = commandRunner.run(DEFAULT_STATUS_ARGS);
    const status = parseStatus(statusResult, Date.now());
    return {
      providerId: provider.providerId,
      providerType: provider.providerType,
      validationState: provider.validationState,
      modelId: provider.modelId,
      baseUrl: status.baseUrl,
      apiKey: status.apiKey,
      apiKeyHeaderName: status.apiKeyHeaderName,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      retryBaseDelayMs: provider.retryBaseDelayMs,
    };
  };
}
