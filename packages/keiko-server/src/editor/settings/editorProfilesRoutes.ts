import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  isWorkspaceProfileDisplayName,
  isWorkspaceProfileRef,
  parseEditorM7SettingPatch,
  type EditorM11ProfileMutation,
  type EditorM11ProfileMutationAction,
  type EditorM11ProfileMutationResult,
  type EditorM7SettingId,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../../routes.js";
import type { EditorProfilesControlMutation } from "./editorSettingsControl.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

type UnknownRecord = Readonly<Record<string, unknown>>;
type ParsedProfileMutation = Omit<EditorM11ProfileMutation, "schemaVersion">;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function profileAction(value: unknown): EditorM11ProfileMutationAction | undefined {
  return ["create", "rename", "duplicate", "delete", "switch", "set", "reset"].includes(
    value as EditorM11ProfileMutationAction,
  )
    ? (value as EditorM11ProfileMutationAction)
    : undefined;
}

function profileRoot(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROOT_CHARS
    ? value
    : null;
}

function settingIds(value: unknown): readonly EditorM7SettingId[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const ids = value.filter(
    (candidate): candidate is EditorM7SettingId =>
      typeof candidate === "string" &&
      EDITOR_M7_SETTING_REGISTRY.some((definition) => definition.id === candidate),
  );
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined;
}

function profileRef(value: unknown): ParsedProfileMutation["profileRef"] {
  return isWorkspaceProfileRef(value) ? value : undefined;
}

function baseMutation(
  value: UnknownRecord,
  action: EditorM11ProfileMutationAction,
  root: string | undefined,
): Pick<ParsedProfileMutation, "action" | "expectedRevision" | "root"> {
  return {
    action,
    expectedRevision: value.expectedRevision as number,
    ...(root === undefined ? {} : { root }),
  };
}

function parseNamedMutation(
  value: UnknownRecord,
  action: "create" | "rename" | "duplicate",
  root: string | undefined,
): ParsedProfileMutation | undefined {
  if (!isWorkspaceProfileDisplayName(value.displayName)) return undefined;
  if (value.displayName.trim() !== value.displayName) return undefined;
  const ref = profileRef(value.profileRef);
  if (action !== "create" && ref === undefined) return undefined;
  if (action === "create" && value.profileRef !== undefined) return undefined;
  if (value.values !== undefined || value.settingIds !== undefined) return undefined;
  return {
    ...baseMutation(value, action, root),
    ...(ref === undefined ? {} : { profileRef: ref }),
    displayName: value.displayName,
  };
}

function parseRefMutation(
  value: UnknownRecord,
  action: "delete" | "switch",
  root: string | undefined,
): ParsedProfileMutation | undefined {
  const ref = profileRef(value.profileRef);
  if (ref === undefined) return undefined;
  if (
    value.displayName !== undefined ||
    value.values !== undefined ||
    value.settingIds !== undefined
  ) {
    return undefined;
  }
  return { ...baseMutation(value, action, root), profileRef: ref };
}

function parseSetMutation(
  value: UnknownRecord,
  root: string | undefined,
): ParsedProfileMutation | undefined {
  const ref = profileRef(value.profileRef);
  const parsed = parseEditorM7SettingPatch("user", value.values);
  if (ref === undefined || !parsed.ok) return undefined;
  if (value.displayName !== undefined || value.settingIds !== undefined) return undefined;
  return {
    ...baseMutation(value, "set", root),
    profileRef: ref,
    values: parsed.value.values,
  };
}

function parseResetMutation(
  value: UnknownRecord,
  root: string | undefined,
): ParsedProfileMutation | undefined {
  const ref = profileRef(value.profileRef);
  const ids = settingIds(value.settingIds);
  if (ref === undefined || ids === undefined) return undefined;
  if (value.displayName !== undefined || value.values !== undefined) return undefined;
  return { ...baseMutation(value, "reset", root), profileRef: ref, settingIds: ids };
}

function parseMutationBody(value: unknown): ParsedProfileMutation | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, mutationKeys())) return undefined;
  if (value.schemaVersion !== EDITOR_M7_SCHEMA_VERSION || !validRevision(value.expectedRevision)) {
    return undefined;
  }
  const action = profileAction(value.action);
  const root = profileRoot(value.root);
  if (action === undefined || root === null) return undefined;
  return parseActionMutation(value, action, root);
}

function parseActionMutation(
  value: UnknownRecord,
  action: EditorM11ProfileMutationAction,
  root: string | undefined,
): ParsedProfileMutation | undefined {
  if (action === "create" || action === "rename" || action === "duplicate") {
    return parseNamedMutation(value, action, root);
  }
  if (action === "delete" || action === "switch") return parseRefMutation(value, action, root);
  return action === "set" ? parseSetMutation(value, root) : parseResetMutation(value, root);
}

function mutationKeys(): readonly string[] {
  return [
    "schemaVersion",
    "action",
    "expectedRevision",
    "root",
    "profileRef",
    "displayName",
    "values",
    "settingIds",
  ];
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

function profilePrecondition(ctx: RouteContext): number | undefined {
  const value = singleHeader(ctx, "if-match");
  const match = value === undefined ? null : /^"edp-(\d+)"$/u.exec(value);
  if (match === null) return undefined;
  const revision = Number(match[1]);
  return validRevision(revision) ? revision : undefined;
}

function invalidRequest(): RouteResult {
  return {
    status: 400,
    body: errorBody("INVALID_REQUEST", "The editor profile request is invalid."),
  };
}

function resultToRoute(result: EditorM11ProfileMutationResult): RouteResult {
  if (result.kind === "ok") {
    return {
      status: 200,
      body: result,
      headers: { ETag: result.etag, "Cache-Control": "no-store" },
    };
  }
  if (result.kind === "conflict" || result.kind === "idempotencyConflict") {
    const message =
      result.kind === "conflict"
        ? "The editor profile revision is stale."
        : "The idempotency key was already used for another request.";
    return { status: 409, body: errorBody(result.code, message), headers: { ETag: result.etag } };
  }
  if (result.kind === "invalid") {
    return { status: 400, body: errorBody(result.code, "The editor profile request is invalid.") };
  }
  return {
    status: 503,
    body: errorBody(result.code, "Editor profiles are temporarily unavailable."),
  };
}

function affectedSettingIds(body: ParsedProfileMutation): readonly EditorM7SettingId[] {
  if (body.action === "set") return Object.keys(body.values ?? {}) as EditorM7SettingId[];
  if (body.action === "reset") return body.settingIds ?? [];
  if (body.action === "switch" || body.action === "delete") {
    return EDITOR_M7_SETTING_REGISTRY.map((definition) => definition.id);
  }
  return [];
}

export async function handleGetEditorProfiles(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.editorSettingsControl?.readProfiles === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor profiles are unavailable."),
    };
  }
  const snapshot = await deps.editorSettingsControl.readProfiles();
  return {
    status: 200,
    body: snapshot,
    headers: { ETag: snapshot.etag, "Cache-Control": "no-store" },
  };
}

export async function handlePatchEditorProfiles(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.editorSettingsControl?.mutateProfile === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor profiles are unavailable."),
    };
  }
  const raw = await readJsonObject(ctx.req, MAX_BODY_BYTES);
  if (isRouteResult(raw)) return raw;
  const body = parseMutationBody(raw);
  const key = idempotencyKey(ctx);
  const precondition = profilePrecondition(ctx);
  if (body === undefined || key === undefined || precondition !== body.expectedRevision) {
    return invalidRequest();
  }
  return runFilesHandler(async () => mutateResolvedProfile(ctx, deps, body, key));
}

async function mutateResolvedProfile(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
  body: ParsedProfileMutation,
  idempotency: string,
): Promise<RouteResult> {
  const resolved =
    body.root === undefined ? undefined : await resolveRoot(deps.store, body.root, deps.redactor);
  const mutation: EditorProfilesControlMutation = {
    ...body,
    idempotencyKey: idempotency,
    realRoot: resolved?.realRoot,
  };
  const result = await deps.editorSettingsControl?.mutateProfile?.(mutation);
  if (result === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Editor profiles are unavailable."),
    };
  }
  if (result.kind === "ok" && result.changed) {
    deps.editorSettingsEvents?.publish({
      snapshot: result.settings,
      scope: "user",
      settingIds: affectedSettingIds(body),
    });
  }
  return resultToRoute(result);
}
