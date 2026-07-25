import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRequestRoot, runFilesHandler } from "../../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../../routes.js";
import {
  editorSettingsRootToken,
  parseEditorSettingsEtag,
} from "../settings/editorSettingsStore.js";

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

type DebugActivationAction = "activate" | "deactivate";
type UnknownRecord = Readonly<Record<string, unknown>>;

interface ParsedBody {
  readonly root: string;
  readonly expectedRevision: number;
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

function parseBody(value: unknown): ParsedBody | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["root", "expectedRevision"])) return undefined;
  if (
    typeof value.root !== "string" ||
    value.root.length === 0 ||
    value.root.length > MAX_ROOT_CHARS
  ) {
    return undefined;
  }
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0
  ) {
    return undefined;
  }
  return { root: value.root, expectedRevision: value.expectedRevision };
}

function singleHeader(ctx: RouteContext, name: "idempotency-key" | "if-match"): string | undefined {
  const value = ctx.req.headers[name];
  if (!Array.isArray(value)) return value;
  return value.length === 1 ? value[0] : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function idempotencyKey(ctx: RouteContext): string | undefined {
  const value = singleHeader(ctx, "idempotency-key")?.trim();
  if (value === undefined || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return undefined;
  }
  return hasControlCharacter(value) ? undefined : value;
}

function hasWorkspaceRevisionPrecondition(
  ctx: RouteContext,
  expectedRevision: number,
  realRoot: string,
): boolean {
  const parsed = parseEditorSettingsEtag(singleHeader(ctx, "if-match"));
  if (parsed?.workspaceRevision !== expectedRevision) return false;
  return parsed.rootToken === editorSettingsRootToken(realRoot);
}

function unavailable(): RouteResult {
  return {
    status: 503,
    body: errorBody("STATE_UNAVAILABLE", "Debug activation settings are unavailable."),
  };
}

function invalid(): RouteResult {
  return {
    status: 400,
    body: errorBody("INVALID_REQUEST", "The debug activation request is invalid."),
  };
}

function resultToRoute(
  result: Awaited<ReturnType<NonNullable<UiHandlerDeps["editorSettingsControl"]>["mutate"]>>,
): RouteResult {
  if (result.kind === "ok") {
    return {
      status: 200,
      body: result,
      headers: { ETag: result.etag, "Cache-Control": "no-store" },
    };
  }
  if (result.kind === "conflict") {
    return {
      status: 409,
      body: errorBody(result.code, "The editor settings revision is stale."),
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
      body: errorBody(result.code, "The debug activation request is invalid."),
    };
  }
  return unavailable();
}

async function handleMutation(
  action: DebugActivationAction,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.editorSettingsControl === undefined || deps.debugActivationControl === undefined) {
    return unavailable();
  }
  const raw = await readJsonObject(ctx.req, MAX_CONTROL_BODY_BYTES);
  if (isRouteResult(raw)) return raw;
  const body = parseBody(raw);
  const key = idempotencyKey(ctx);
  if (body === undefined || key === undefined) return invalid();
  return runFilesHandler(async () => {
    const resolved = await resolveRequestRoot(ctx, deps, body.root);
    if (!hasWorkspaceRevisionPrecondition(ctx, body.expectedRevision, resolved.realRoot))
      return invalid();
    const result = await deps.editorSettingsControl?.mutate({
      action: "set",
      expectedRevision: body.expectedRevision,
      idempotencyKey: key,
      realRoot: resolved.realRoot,
      scope: "workspace",
      values: { debuggingEnabled: action === "activate" },
    });
    return result === undefined ? unavailable() : resultToRoute(result);
  });
}

export function handleActivateDebugActivation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return handleMutation("activate", ctx, deps);
}

export function handleDeactivateDebugActivation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return handleMutation("deactivate", ctx, deps);
}
