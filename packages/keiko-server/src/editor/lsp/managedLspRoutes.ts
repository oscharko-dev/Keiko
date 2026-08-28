import type {
  ManagedLspControlMutation,
  ManagedLspControlResponse,
  ManagedLspControlResult,
  ManagedLspControlSnapshot,
  ManagedLspProcessHealthSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  parseManagedLspControlRequest,
  parseManagedLspRevisionEtag,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-route";
import { resolveManagedLspActivation } from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-activation";

import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRequestRoot, runFilesHandler } from "../../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../../routes.js";
import { listHostLspHealthSnapshotsForRoot } from "./hostLanguageOperation.js";
import { managedLspConfigurationDefaults } from "./managedLspConfigurationDefaults.js";
import {
  detectPythonConfigurationPrecedence,
  resolvePythonRuntimeIdentitySource,
} from "./providers/pythonProvider.js";

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
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
    const code = value.codePointAt(index);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function revisionPrecondition(ctx: RouteContext, expectedRevision: number): string | undefined {
  return parseManagedLspRevisionEtag(singleHeader(ctx, "if-match"), expectedRevision);
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
    const resolved = await resolveRequestRoot(ctx, deps, ctx.url.searchParams.get("root"));
    const snapshot = await deps.managedLspControl?.read(resolved.realRoot);
    if (snapshot === undefined) throw new Error("managed LSP control disappeared");
    const health = listHostLspHealthSnapshotsForRoot(resolved.realRoot);
    const response = {
      ...snapshot,
      languages: projectManagedLspLiveLanguages(snapshot, health),
      configurationDefaults: managedLspConfigurationDefaults(snapshot.revision, snapshot.etag),
      health,
      providerMetadata: [
        {
          language: "python",
          configurationSource: detectPythonConfigurationPrecedence(resolved.realRoot),
          runtimeIdentitySource: pythonRuntimeIdentitySourceFor(snapshot),
        },
      ],
    } satisfies ManagedLspControlResponse;
    return {
      status: 200,
      body: response,
      headers: { ETag: snapshot.etag, "Cache-Control": "no-store" },
    };
  });
}

function pythonRuntimeIdentitySourceFor(
  snapshot: ManagedLspControlSnapshot,
): "venv" | "interpreter" {
  const configuration = snapshot.configurations.find((entry) => entry.language === "python");
  return configuration?.language === "python"
    ? resolvePythonRuntimeIdentitySource(configuration.settings)
    : "interpreter";
}

export function projectManagedLspLiveLanguages(
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
  const restartAfterDisposal = restartRequired && runtime === undefined;
  return resolveManagedLspActivation({
    schemaVersion: "1",
    language: current.language,
    configurationRevision: current.configurationRevision,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: settings?.workspaceActivation === "enabled" ? "enabled" : "unset",
    legacyEnvironment: "unset",
    // An accepted configuration update intentionally disposes this pool entry. With no health
    // sample, preserve the persisted desired-state transition without fabricating capabilities;
    // the response's health array remains empty until the explicit restart starts a new process.
    negotiation: restartAfterDisposal ? "negotiated" : negotiationState(runtime),
    runtimeHealth: restartAfterDisposal ? "healthy" : runtimeHealth(runtime),
    restartRequired,
    // A projectable control status has already proven current server-owned trust. Restricted
    // statuses return above and therefore cannot be widened by this live-health projection.
    workspaceTrust: "trusted",
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
  const parsedBody = parseManagedLspControlRequest(raw);
  const body = parsedBody.ok ? parsedBody.value : undefined;
  const key = idempotencyKey(ctx);
  const expectedEtag =
    body === undefined ? undefined : revisionPrecondition(ctx, body.expectedRevision);
  if (body === undefined || key === undefined || expectedEtag === undefined) {
    return {
      status: 400,
      body: errorBody("INVALID_REQUEST", "The managed language request is invalid."),
    };
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRequestRoot(ctx, deps, body.root);
    const mutation: ManagedLspControlMutation = {
      ...body,
      root: resolved.realRoot,
      expectedEtag,
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
