import {
  MANAGED_LSP_LANGUAGES,
  parseManagedLspRuntimeConfiguration,
  resolveManagedLspActivation,
  type ManagedLspLanguage,
  type ManagedLspProcessHealthSnapshot,
  type ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../../routes.js";
import type {
  ManagedLspControlAction,
  ManagedLspControlMutation,
  ManagedLspControlResult,
  ManagedLspControlSnapshot,
} from "./managedLspControl.js";
import { listHostLspHealthSnapshotsForRoot } from "./hostLanguageOperation.js";
import { detectPythonConfigurationPrecedence } from "./providers/pythonProvider.js";

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const ACTIONS: readonly ManagedLspControlAction[] = [
  "activate",
  "deactivate",
  "configure",
  "reset",
  "rollback",
  "restart",
];

type UnknownRecord = Readonly<Record<string, unknown>>;

interface ParsedMutationBody {
  readonly action: ManagedLspControlAction;
  readonly expectedRevision: number;
  readonly language: ManagedLspLanguage;
  readonly root: string;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseConfiguration(
  action: ManagedLspControlAction,
  value: unknown,
): ManagedLspRuntimeConfiguration | undefined | null {
  if (action !== "configure") return value === undefined ? undefined : null;
  const parsed = parseManagedLspRuntimeConfiguration(value);
  return parsed.ok ? parsed.value : null;
}

function parseMutationBody(value: unknown): ParsedMutationBody | undefined {
  if (!isRecord(value)) return undefined;
  if (!validMutationScalars(value)) return undefined;
  const action = value.action as ManagedLspControlAction;
  const configuration = parseConfiguration(action, value.configuration);
  if (configuration === null) return undefined;
  return {
    root: value.root as string,
    language: value.language as ManagedLspLanguage,
    action,
    expectedRevision: value.expectedRevision as number,
    ...(configuration === undefined ? {} : { configuration }),
  };
}

function validMutationScalars(value: UnknownRecord): boolean {
  return [
    hasOnlyKeys(value, ["root", "language", "action", "expectedRevision", "configuration"]),
    typeof value.root === "string" && value.root.length > 0 && value.root.length <= MAX_ROOT_CHARS,
    MANAGED_LSP_LANGUAGES.includes(value.language as ManagedLspLanguage),
    ACTIONS.includes(value.action as ManagedLspControlAction),
    typeof value.expectedRevision === "number" &&
      Number.isSafeInteger(value.expectedRevision) &&
      value.expectedRevision >= 0,
  ].every(Boolean);
}

function singleHeader(ctx: RouteContext, name: "idempotency-key" | "if-match"): string | undefined {
  const value = ctx.req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function idempotencyKey(ctx: RouteContext): string | undefined {
  const value = singleHeader(ctx, "idempotency-key")?.trim();
  if (value === undefined || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return undefined;
  }
  return hasControlCharacter(value) ? undefined : value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasRevisionPrecondition(ctx: RouteContext, expectedRevision: number): boolean {
  const value = singleHeader(ctx, "if-match");
  const match = value === undefined ? null : /^"lspcfg-(\d+)-[A-Za-z0-9_-]{16,64}"$/u.exec(value);
  return match !== null && Number(match[1]) === expectedRevision;
}

function resultToRoute(result: ManagedLspControlResult): RouteResult {
  if (result.kind === "ok") {
    return {
      status: 200,
      body: result,
      headers: { ETag: result.etag, "Cache-Control": "no-store" },
    };
  }
  if (result.kind === "denied") {
    return {
      status: 403,
      body: errorBody(
        "LSP_ACTIVATION_DENIED",
        "The language activation policy denied this request.",
      ),
      headers: { ETag: result.etag },
    };
  }
  if (result.kind === "conflict") {
    return {
      status: 412,
      body: errorBody(result.code, "The managed language settings revision is stale."),
      headers: { ETag: result.etag },
    };
  }
  if (result.kind === "idempotencyConflict") {
    return {
      status: 409,
      body: errorBody(result.code, "The idempotency key was already used for another request."),
      headers: { ETag: result.etag },
    };
  }
  if (result.kind === "invalid") {
    return {
      status: 400,
      body: errorBody(result.code, "The managed language request is invalid."),
    };
  }
  return {
    status: 503,
    body: errorBody(result.code, "Managed language settings are temporarily unavailable."),
  };
}

export async function handleGetManagedLspControl(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.managedLspControl === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Managed language settings are unavailable."),
    };
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRoot(deps.store, ctx.url.searchParams.get("root"), deps.redactor);
    const snapshot = await deps.managedLspControl?.read(resolved.realRoot);
    if (snapshot === undefined) throw new Error("managed LSP control disappeared");
    const health = listHostLspHealthSnapshotsForRoot(resolved.realRoot);
    return {
      status: 200,
      body: {
        ...snapshot,
        languages: liveLanguages(snapshot, health),
        health,
        providerMetadata: [
          {
            language: "python",
            configurationSource: detectPythonConfigurationPrecedence(resolved.realRoot),
          },
        ],
      },
      headers: { ETag: snapshot.etag, "Cache-Control": "no-store" },
    };
  });
}

function liveLanguages(
  snapshot: ManagedLspControlSnapshot,
  health: readonly ManagedLspProcessHealthSnapshot[],
): ManagedLspControlSnapshot["languages"] {
  return snapshot.languages.map((current) => liveLanguage(current, snapshot, health));
}

function liveLanguage(
  current: ManagedLspControlSnapshot["languages"][number],
  snapshot: ManagedLspControlSnapshot,
  health: readonly ManagedLspProcessHealthSnapshot[],
): ManagedLspControlSnapshot["languages"][number] {
  if (!current.ok || !liveProjectableState(current.state)) return current;
  const runtime = health.find((entry) => entry.language === current.language);
  const settings = snapshot.settings.find((entry) => entry.language === current.language);
  const restartRequired = settings?.restartRequired ?? false;
  return resolveManagedLspActivation({
    schemaVersion: "1",
    language: current.language,
    configurationRevision: current.configurationRevision,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: settings?.workspaceActivation === "enabled" ? "enabled" : "unset",
    legacyEnvironment: "unset",
    negotiation: restartRequired ? "negotiated" : negotiationState(runtime),
    runtimeHealth: restartRequired ? "healthy" : runtimeHealth(runtime),
    restartRequired,
  });
}

function liveProjectableState(state: string): boolean {
  return ["available", "starting", "active", "degraded", "unhealthy", "restartRequired"].includes(
    state,
  );
}

function negotiationState(
  health: ManagedLspProcessHealthSnapshot | undefined,
): "notStarted" | "starting" | "negotiated" | "requiredCapabilityMissing" {
  if (health === undefined) return "notStarted";
  if (health.status === "STARTING" || health.status === "INITIALIZING") return "starting";
  if (health.status !== "READY") return "negotiated";
  return health.negotiatedOperations.length === 0 ? "requiredCapabilityMissing" : "negotiated";
}

function runtimeHealth(
  health: ManagedLspProcessHealthSnapshot | undefined,
): "unknown" | "healthy" | "degraded" | "unhealthy" {
  if (health === undefined || health.status === "STARTING" || health.status === "INITIALIZING") {
    return "unknown";
  }
  if (health.status === "READY") return health.failureCount > 0 ? "degraded" : "healthy";
  return ["CRASHED", "RESTART_THROTTLED", "INITIALIZE_TIMEOUT"].includes(health.status)
    ? "unhealthy"
    : "degraded";
}

export async function handlePutManagedLspControl(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.managedLspControl === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Managed language settings are unavailable."),
    };
  }
  const raw = await readJsonObject(ctx.req, MAX_CONTROL_BODY_BYTES);
  if (isRouteResult(raw)) return raw;
  const body = parseMutationBody(raw);
  const key = idempotencyKey(ctx);
  if (
    body === undefined ||
    key === undefined ||
    !hasRevisionPrecondition(ctx, body.expectedRevision)
  ) {
    return {
      status: 400,
      body: errorBody("INVALID_REQUEST", "The managed language request is invalid."),
    };
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRoot(deps.store, body.root, deps.redactor);
    const mutation: ManagedLspControlMutation = {
      ...body,
      root: resolved.realRoot,
      idempotencyKey: key,
      actorClass: "localHuman",
    };
    const result = await deps.managedLspControl?.mutate(mutation);
    return result === undefined
      ? {
          status: 503,
          body: errorBody("STATE_UNAVAILABLE", "Managed language settings are unavailable."),
        }
      : resultToRoute(result);
  });
}
