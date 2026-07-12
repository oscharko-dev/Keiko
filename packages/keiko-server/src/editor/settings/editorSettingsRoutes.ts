import {
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M7_SCHEMA_VERSION,
  parseEditorM7SettingPatch,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
  type EditorM7SettingsMutationAction,
  type EditorM7SettingsMutationResult,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../../files.js";
import {
  STREAMING,
  errorBody,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../../routes.js";
import { SSE_HEADERS, startSseHeartbeat } from "../../sse.js";
import type { EditorSettingsControlMutation } from "./editorSettingsControl.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

type UnknownRecord = Readonly<Record<string, unknown>>;

interface ParsedMutationBody {
  readonly action: EditorM7SettingsMutationAction;
  readonly expectedRevision: number;
  readonly root?: string | undefined;
  readonly scope: EditorM7SettingScope;
  readonly values?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
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

function parseScope(value: unknown): EditorM7SettingScope | undefined {
  return value === "user" || value === "workspace" ? value : undefined;
}

function parseAction(value: unknown): EditorM7SettingsMutationAction | undefined {
  return value === "set" || value === "reset" ? value : undefined;
}

function isSettingId(value: unknown): value is EditorM7SettingId {
  return (
    typeof value === "string" &&
    EDITOR_M7_SETTING_REGISTRY.some((definition) => definition.id === value)
  );
}

function parseSettingIds(value: unknown): readonly EditorM7SettingId[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const ids = value.filter(isSettingId);
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined;
}

function parseValues(
  scope: EditorM7SettingScope,
  value: unknown,
): Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined {
  const parsed = parseEditorM7SettingPatch(scope, value);
  return parsed.ok ? parsed.value.values : undefined;
}

function validRoot(value: unknown, scope: EditorM7SettingScope): string | undefined | null {
  if (scope === "user" && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ROOT_CHARS) return null;
  return value;
}

function parseMutationBody(value: unknown): ParsedMutationBody | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, mutationKeys())) return undefined;
  if (value.schemaVersion !== EDITOR_M7_SCHEMA_VERSION) return undefined;
  const scope = parseScope(value.scope);
  const action = parseAction(value.action);
  if (scope === undefined || action === undefined || !validRevision(value.expectedRevision)) {
    return undefined;
  }
  const root = validRoot(value.root, scope);
  if (root === null) return undefined;
  if (action === "set") return parseSetBody(value, scope, action, root);
  return parseResetBody(value, scope, action, root);
}

function mutationKeys(): readonly string[] {
  return ["schemaVersion", "root", "scope", "action", "expectedRevision", "values", "settingIds"];
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSetBody(
  value: UnknownRecord,
  scope: EditorM7SettingScope,
  action: "set",
  root: string | undefined,
): ParsedMutationBody | undefined {
  if (value.values === undefined || value.settingIds !== undefined) return undefined;
  const values = parseValues(scope, value.values);
  return values === undefined
    ? undefined
    : { action, expectedRevision: value.expectedRevision as number, root, scope, values };
}

function parseResetBody(
  value: UnknownRecord,
  scope: EditorM7SettingScope,
  action: "reset",
  root: string | undefined,
): ParsedMutationBody | undefined {
  if (value.settingIds === undefined || value.values !== undefined) return undefined;
  const settingIds = parseSettingIds(value.settingIds);
  return settingIds === undefined
    ? undefined
    : { action, expectedRevision: value.expectedRevision as number, root, scope, settingIds };
}

function singleHeader(ctx: RouteContext, name: "idempotency-key" | "if-match"): string | undefined {
  const value = ctx.req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
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

function hasRevisionPrecondition(ctx: RouteContext, body: ParsedMutationBody): boolean {
  const value = singleHeader(ctx, "if-match");
  const match =
    value === undefined ? null : /^"edm7-(\d+)-(\d+)-[A-Za-z0-9_-]{4,64}"$/u.exec(value);
  if (match === null) return false;
  const revision = body.scope === "user" ? Number(match[1]) : Number(match[2]);
  return revision === body.expectedRevision;
}

function resultToRoute(result: EditorM7SettingsMutationResult): RouteResult {
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
    return { status: 400, body: errorBody(result.code, "The editor settings request is invalid.") };
  }
  return {
    status: 503,
    body: errorBody(result.code, "Editor settings are temporarily unavailable."),
  };
}

function rootResolution(realRoot: string | undefined): RouteResult {
  return { status: 200, body: { realRoot: realRoot ?? null } };
}

function resolvedRootFrom(result: RouteResult): string | undefined {
  if (result.status !== 200 || !isRecord(result.body)) return undefined;
  const value = result.body.realRoot;
  return typeof value === "string" ? value : undefined;
}

async function resolveEventRoot(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolved =
      rootInput === null ? undefined : await resolveRoot(deps.store, rootInput, deps.redactor);
    return rootResolution(resolved?.realRoot);
  });
}

export async function handleGetEditorSettings(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.editorSettingsControl === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor settings are unavailable."),
    };
  }
  return runFilesHandler(async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolved =
      rootInput === null ? undefined : await resolveRoot(deps.store, rootInput, deps.redactor);
    const snapshot = await deps.editorSettingsControl?.read(resolved?.realRoot);
    if (snapshot === undefined) throw new Error("editor settings control disappeared");
    return {
      status: 200,
      body: snapshot,
      headers: { ETag: snapshot.etag, "Cache-Control": "no-store" },
    };
  });
}

export async function handlePatchEditorSettings(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.editorSettingsControl === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor settings are unavailable."),
    };
  }
  const raw = await readJsonObject(ctx.req, MAX_BODY_BYTES);
  if (isRouteResult(raw)) return raw;
  const body = parseMutationBody(raw);
  const key = idempotencyKey(ctx);
  if (body === undefined || key === undefined || !hasRevisionPrecondition(ctx, body)) {
    return {
      status: 400,
      body: errorBody("INVALID_REQUEST", "The editor settings request is invalid."),
    };
  }
  return runFilesHandler(async () => {
    const resolved =
      body.root === undefined ? undefined : await resolveRoot(deps.store, body.root, deps.redactor);
    const mutation: EditorSettingsControlMutation = {
      ...body,
      realRoot: resolved?.realRoot,
      idempotencyKey: key,
    };
    const result = await deps.editorSettingsControl?.mutate(mutation);
    if (result === undefined) {
      return {
        status: 503,
        body: errorBody("STATE_UNAVAILABLE", "Editor settings are unavailable."),
      };
    }
    if (result.kind === "ok" && result.changed) {
      deps.editorSettingsEvents?.publish({
        snapshot: result.snapshot,
        scope: body.scope,
        settingIds: affectedIds(body),
      });
    }
    return resultToRoute(result);
  });
}

export async function handleEditorSettingsEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  if (deps.editorSettingsEvents === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor settings events are unavailable."),
    };
  }
  const resolved = await resolveEventRoot(ctx, deps);
  if (resolved.status !== 200) return resolved;
  const controller = new AbortController();
  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);
  const unsubscribe = deps.editorSettingsEvents.subscribe({
    controller,
    res: ctx.res,
    realRoot: resolvedRootFrom(resolved),
  });
  ctx.res.on("close", () => {
    stopHeartbeat();
    controller.abort();
    unsubscribe();
  });
  return STREAMING;
}

function affectedIds(body: ParsedMutationBody): readonly EditorM7SettingId[] {
  return body.action === "set"
    ? (Object.keys(body.values ?? {}) as EditorM7SettingId[])
    : (body.settingIds ?? []);
}
