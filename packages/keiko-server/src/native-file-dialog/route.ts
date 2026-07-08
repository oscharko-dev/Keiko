// Epic #1941 — native dialog BFF route (ADR-0118 D1/D2).
//
// `POST /api/native-file-dialog/open` is the only surface through which the browser can request a
// native picker, and `GET /api/native-file-dialog/capability` is how it learns whether the BFF
// host platform has an adapter at all. Adapter output is UNTRUSTED until this module validates it:
// selection count per mode, NUL rejection, absolute shape, existence, expected kind, realpath,
// deny-list, and metadata-redaction safety — directories go through the exact same `resolveRoot`
// policy as every `/api/files/*` root, files mirror that chain (files.ts only models directory
// roots). Errors are stable codes with generic messages; selected paths and adapter stderr never
// appear in error bodies, diagnostics, or evidence.

import { dirname } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  NativeFileDialogCapability,
  NativeFileDialogRequest,
  NativeFileDialogResponse,
  NativeFileDialogSelection,
  NativeFileDialogSelectionKind,
} from "@oscharko-dev/keiko-contracts";
import {
  nativeFileDialogExpectedKind,
  nativeFileDialogSelectionBounds,
  validateNativeFileDialogRequest,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { pathIsDenied } from "../files-deny.js";
import { FilesError, readJsonObject, resolveRoot } from "../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import {
  createNativeFileDialogAdapter,
  NativeFileDialogAdapterError,
  nativeFileDialogSupported,
  type NativeFileDialogAdapter,
  type NativeFileDialogAdapterResult,
} from "./adapter.js";

const MAX_NATIVE_FILE_DIALOG_BODY_BYTES = 16_384;

// Route-level single flight: one BFF process can sensibly host one native dialog at a time.
// State lives in an injectable object (not a module `let`) so tests stay hermetic under
// concurrency; production uses the module-level default instance.
export interface NativeFileDialogRouteState {
  active: boolean;
}

export function createNativeFileDialogRouteState(): NativeFileDialogRouteState {
  return { active: false };
}

const defaultRouteState = createNativeFileDialogRouteState();

// Test seam, mirroring `gitRouteOptions`: production leaves this undefined and the route lazily
// selects the platform adapter and the module-level single-flight state.
export interface NativeFileDialogRouteOptions {
  readonly adapter?: NativeFileDialogAdapter | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly state?: NativeFileDialogRouteState | undefined;
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function dialogError(
  status: number,
  code: string,
  message: string,
  correlationId: string | undefined,
): RouteResult {
  return { status, body: errorBody(code, message, correlationId) };
}

const INVALID_SELECTION_MESSAGE = "The native dialog returned a selection Keiko cannot accept.";
const DENIED_SELECTION_MESSAGE = "The selected path is excluded from Keiko's read surface.";

class SelectionRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionRejection";
  }
}

// Best-effort hygiene for the starting-location HINT: forward only an existing directory (a file
// hint collapses to its parent), otherwise drop it. No deny-check here — the hint only positions
// a dialog that can browse the whole filesystem anyway; policy applies on the RETURN path.
async function normalizeDefaultPath(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  try {
    const stats = await stat(value);
    if (stats.isDirectory()) return value;
    if (stats.isFile()) return dirname(value);
    return undefined;
  } catch {
    return undefined;
  }
}

function redactionSafe(value: string, deps: UiHandlerDeps): boolean {
  return String(deps.redactor(value)) === value;
}

// Mirrors `resolveArbitraryRoot` for FILE targets (files.ts only models directory roots): deny on
// the raw path, realpath, deny again on the resolved target, expected-kind stat, redaction safety.
async function validateFileSelection(path: string, deps: UiHandlerDeps): Promise<void> {
  if (pathIsDenied(path)) throw new SelectionRejection(DENIED_SELECTION_MESSAGE);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  }
  if (pathIsDenied(real)) throw new SelectionRejection(DENIED_SELECTION_MESSAGE);
  const stats = await stat(real).catch(() => {
    throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  });
  if (!stats.isFile()) throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  if (!redactionSafe(path, deps) || !redactionSafe(real, deps)) {
    throw new SelectionRejection(DENIED_SELECTION_MESSAGE);
  }
}

// Directory selections reuse the Files BFF root policy VERBATIM so a folder picked natively is
// accepted under exactly the rules `/api/files/*` applies to roots (absolute, deny raw + real,
// realpath, redaction-safe).
async function validateDirectorySelection(path: string, deps: UiHandlerDeps): Promise<void> {
  try {
    await resolveRoot(deps.store, path, deps.redactor);
  } catch (error) {
    if (error instanceof FilesError) {
      const denied = error.code === "DENIED";
      throw new SelectionRejection(denied ? DENIED_SELECTION_MESSAGE : INVALID_SELECTION_MESSAGE);
    }
    throw error;
  }
}

async function validateSelection(
  path: string,
  kind: NativeFileDialogSelectionKind,
  deps: UiHandlerDeps,
): Promise<NativeFileDialogSelection> {
  if (path.includes("\0") || path.trim().length === 0) {
    throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  }
  // Both platform dialogs return platform-absolute paths; anything else means a broken helper.
  const looksAbsolute =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\");
  if (!looksAbsolute) throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  if (kind === "directory") {
    await validateDirectorySelection(path, deps);
  } else {
    await validateFileSelection(path, deps);
  }
  return { path, kind };
}

async function projectSelections(
  request: NativeFileDialogRequest,
  adapterResult: NativeFileDialogAdapterResult,
  deps: UiHandlerDeps,
): Promise<NativeFileDialogResponse> {
  const bounds = nativeFileDialogSelectionBounds(request.mode);
  if (adapterResult.paths.length < bounds.min || adapterResult.paths.length > bounds.max) {
    throw new SelectionRejection(INVALID_SELECTION_MESSAGE);
  }
  const kind = nativeFileDialogExpectedKind(request.mode);
  const selections: NativeFileDialogSelection[] = [];
  for (const path of adapterResult.paths) {
    selections.push(await validateSelection(path, kind, deps));
  }
  return { cancelled: false, selections };
}

function emitAdapterDiagnostic(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: NativeFileDialogAdapterError,
): void {
  // Operator record only: the AdapterError message is content-free by construction (exit codes and
  // byte counts), and the redactor guards against future drift. Nothing reaches the browser body.
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: ctx.correlationId ?? "uncorrelated",
      operation: "POST /api/native-file-dialog/open",
      source: "native-file-dialog",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
}

function mapAdapterError(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: NativeFileDialogAdapterError,
): RouteResult {
  if (error.reason === "unsupported") {
    return dialogError(
      501,
      "NATIVE_DIALOG_UNSUPPORTED",
      "Native dialogs are not supported on this platform.",
      ctx.correlationId,
    );
  }
  emitAdapterDiagnostic(ctx, deps, error);
  if (error.reason === "timeout") {
    return dialogError(
      504,
      "NATIVE_DIALOG_TIMEOUT",
      "The native dialog timed out and was closed.",
      ctx.correlationId,
    );
  }
  return dialogError(
    502,
    "NATIVE_DIALOG_FAILED",
    "The native dialog could not be opened.",
    ctx.correlationId,
  );
}

async function openAndProject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: NativeFileDialogRequest,
  adapter: NativeFileDialogAdapter,
): Promise<RouteResult> {
  const defaultPath = await normalizeDefaultPath(request.defaultPath);
  const adapterRequest: NativeFileDialogRequest = {
    mode: request.mode,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(defaultPath !== undefined ? { defaultPath } : {}),
    ...(request.filters !== undefined ? { filters: request.filters } : {}),
  };
  try {
    const adapterResult = await adapter.open(adapterRequest);
    if (adapterResult.cancelled) {
      return { status: 200, body: { cancelled: true, selections: [] } };
    }
    return { status: 200, body: await projectSelections(request, adapterResult, deps) };
  } catch (error) {
    if (error instanceof NativeFileDialogAdapterError) return mapAdapterError(ctx, deps, error);
    if (error instanceof SelectionRejection) {
      return dialogError(422, "NATIVE_DIALOG_INVALID_SELECTION", error.message, ctx.correlationId);
    }
    throw error;
  }
}

type OpenGate =
  | {
      readonly ok: true;
      readonly adapter: NativeFileDialogAdapter;
      readonly state: NativeFileDialogRouteState;
    }
  | { readonly ok: false; readonly result: RouteResult };

// An injected test adapter counts as supported regardless of the host platform.
function resolveAdapter(
  options: NativeFileDialogRouteOptions | undefined,
): NativeFileDialogAdapter | undefined {
  if (options?.adapter !== undefined) return options.adapter;
  const platform = options?.platform ?? process.platform;
  return nativeFileDialogSupported(platform) ? createNativeFileDialogAdapter(platform) : undefined;
}

// Platform-support and single-flight gate, evaluated BEFORE any adapter work.
function gateOpen(ctx: RouteContext, options: NativeFileDialogRouteOptions | undefined): OpenGate {
  const adapter = resolveAdapter(options);
  if (adapter === undefined) {
    return {
      ok: false,
      result: dialogError(
        501,
        "NATIVE_DIALOG_UNSUPPORTED",
        "Native dialogs are not supported on this platform.",
        ctx.correlationId,
      ),
    };
  }
  const state = options?.state ?? defaultRouteState;
  if (state.active) {
    return {
      ok: false,
      result: dialogError(
        409,
        "NATIVE_DIALOG_ALREADY_OPEN",
        "A native dialog is already open.",
        ctx.correlationId,
      ),
    };
  }
  return { ok: true, adapter, state };
}

export async function handleNativeFileDialogOpen(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_NATIVE_FILE_DIALOG_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = validateNativeFileDialogRequest(body);
  if (!parsed.ok) {
    return dialogError(400, "BAD_REQUEST", parsed.error, ctx.correlationId);
  }
  const gate = gateOpen(ctx, deps.nativeFileDialog);
  if (!gate.ok) return gate.result;
  gate.state.active = true;
  try {
    return await openAndProject(ctx, deps, parsed.value, gate.adapter);
  } finally {
    gate.state.active = false;
  }
}

export function handleNativeFileDialogCapability(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const options = deps.nativeFileDialog;
  const supported =
    options?.adapter !== undefined ||
    nativeFileDialogSupported(options?.platform ?? process.platform);
  const body: NativeFileDialogCapability = { supported };
  return { status: 200, body };
}
