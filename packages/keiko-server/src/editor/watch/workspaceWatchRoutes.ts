import type { ServerResponse } from "node:http";

import type {
  EditorM7WatchEvent,
  EditorM7WatchSnapshot,
  EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { correlationIdOrUnknown } from "../../correlation.js";
import {
  requestRootAccessResolver,
  resolveRequestRoot,
  runFilesHandler,
  type ResolvedProjectRoot,
} from "../../files.js";
import { processServerLogSink } from "../../process-log-sink.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../../routes.js";
import { SSE_HEADERS, readyMessage, startSseHeartbeat } from "../../sse.js";
import { writeOrDestroy } from "../../sse-write.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { WorkspaceWatchSubscribeResult } from "./workspaceWatchService.js";

// Body-free stand-in for the watched root, matching workspaceWatchService.ts's own `rootToken`
// derivation (sha256, first 24 hex chars) so this line can be joined against the watch session's
// snapshot without ever writing the real path into the activity log.
function watchRootToken(root: string): string {
  return sha256Hex(root).slice(0, 24);
}

// Which side of the subscription the denial happened on. `admission` is the very first re-proof,
// before any subscriber exists; `stream` is a live subscriber losing authority mid-stream.
type WatchAuthorityDenialPhase = "admission" | "stream";

// AGENTS.md §8 Rule 1: a watch that is denied or disappears mid-stream must be reconstructable from
// the activity log alone. `onAuthorityRevoked` (wired below) previously aborted the controller and
// closed the response with no catalogued op, no errorKind, and no correlation id — indistinguishable
// in the log from an ordinary client disconnect. Mirrors `workspace-root-denial-log.ts`'s
// `recordWorkspaceRootDenial`: same `security` category, same correlation-or-unknown fallback,
// body-free `extra`.
function recordWatchAuthorityRevoked(
  ctx: RouteContext,
  root: string,
  phase: WatchAuthorityDenialPhase,
): void {
  processServerLogSink().write({
    level: "warn",
    category: "security",
    op: "editor.workspace-watch.authority-revoked",
    correlationId: correlationIdOrUnknown(ctx.correlationId),
    errorKind: "WATCH_AUTHORITY_REVOKED",
    extra: { decision: "revoked", phase, rootToken: watchRootToken(root) },
  });
}

function eventName(event: EditorM7WatchEvent): string {
  return `editor-watch:${event.kind}`;
}

function frameWatchEvent(event: EditorM7WatchEvent): string {
  return `id: ${String(event.sequence)}\nevent: ${eventName(event)}\ndata: ${JSON.stringify(
    event,
  )}\n\n`;
}

function frameSnapshot(snapshot: EditorM7WatchSnapshot, event = "editor-watch:snapshot"): string {
  return `id: ${String(snapshot.sequence)}\nevent: ${event}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function parseLastSequence(ctx: RouteContext): number | undefined {
  const raw = ctx.req.headers["last-event-id"] ?? ctx.url.searchParams.get("lastEventId");
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function resolveWatchRequestRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<ResolvedProjectRoot> {
  return resolveRequestRoot(ctx, deps, ctx.url.searchParams.get("root"));
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function watcherExclusionsFrom(snapshot: EditorM11SettingsSnapshot): readonly string[] {
  const value = snapshot.settings.find((entry) => entry.id === "watcherExclusions")?.value;
  return isStringArray(value) ? value : [];
}

// Effective watcherExclusions is resolved per subscribe call (not held open for the life of a
// long-running connection); settings failures never block watching, they just leave exclusions at
// their prior/empty value.
async function resolveAdditionalExclusions(
  deps: UiHandlerDeps,
  realRoot: string,
): Promise<readonly string[]> {
  if (deps.editorSettingsControl === undefined) return [];
  try {
    const snapshot = await deps.editorSettingsControl.read(realRoot);
    return watcherExclusionsFrom(snapshot);
  } catch {
    return [];
  }
}

async function resolveWatchRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | { readonly ok: true; readonly resolved: ResolvedProjectRoot }> {
  const result = await runFilesHandler(async () => ({
    status: 200,
    body: { resolved: await resolveWatchRequestRoot(ctx, deps) },
  }));
  if (result.status !== 200) return result;
  const body = result.body as { readonly resolved: ResolvedProjectRoot };
  return { ok: true, resolved: body.resolved };
}

function unavailable(): HandlerOutcome {
  return {
    status: 503,
    body: errorBody("STATE_UNAVAILABLE", "Workspace watch service is unavailable."),
  };
}

function writeInitialFrames(
  res: ServerResponse,
  controller: AbortController,
  result: Extract<WorkspaceWatchSubscribeResult, { readonly kind: "ok" }>,
): void {
  const snapshotEvent = result.snapshotRequired
    ? "editor-watch:snapshot-required"
    : "editor-watch:snapshot";
  writeOrDestroy(res, frameSnapshot(result.snapshot, snapshotEvent), controller);
  for (const event of result.replay) {
    if (controller.signal.aborted) return;
    writeOrDestroy(res, frameWatchEvent(event), controller);
  }
  if (!controller.signal.aborted) writeOrDestroy(res, readyMessage(), controller);
}

function openWatchStream(
  ctx: RouteContext,
  controller: AbortController,
  result: Extract<WorkspaceWatchSubscribeResult, { readonly kind: "ok" }>,
): typeof STREAMING {
  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);
  const unsubscribe = result.unsubscribe;
  const stop = (): void => {
    stopHeartbeat();
    controller.abort();
    unsubscribe();
  };
  ctx.res.on("close", stop);
  writeInitialFrames(ctx.res, controller, result);
  return STREAMING;
}

export async function handleEditorWorkspaceWatchSnapshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  if (deps.workspaceWatchService === undefined) return unavailable();
  const service = deps.workspaceWatchService;
  return runFilesHandler(async () => ({
    status: 200,
    body: service.snapshot((await resolveWatchRequestRoot(ctx, deps)).realRoot),
  }));
}

export async function handleEditorWorkspaceWatchHealth(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  return handleEditorWorkspaceWatchSnapshot(ctx, deps);
}

export async function handleEditorWorkspaceWatchEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  if (deps.workspaceWatchService === undefined) return unavailable();
  const service = deps.workspaceWatchService;
  const resolved = await resolveWatchRoot(ctx, deps);
  if (!("ok" in resolved)) return resolved;
  const { resolved: root } = resolved;
  const additionalExclusions = await resolveAdditionalExclusions(deps, root.realRoot);
  const controller = new AbortController();
  const resolveAccess = requestRootAccessResolver(ctx, deps, root);
  const result = service.subscribe({
    root: root.realRoot,
    lastSequence: parseLastSequence(ctx),
    onEvent: (event) => writeOrDestroy(ctx.res, frameWatchEvent(event), controller),
    // The resolver itself, not a boolean reduction of it (#3347 owner P1): the watch session runs
    // every scan/metadata read of this long-lived effect on the capability each re-proof mints.
    reproveRoot: resolveAccess,
    onAuthorityRevoked: (): void => {
      recordWatchAuthorityRevoked(ctx, root.realRoot, "stream");
      controller.abort();
      if (!ctx.res.writableEnded) ctx.res.end();
    },
    additionalExclusions,
  });
  if (result.kind === "rootUnavailable") {
    // #3347 owner P2: the initial re-proof fails BEFORE a subscriber is added, so revokeRoot() has
    // nobody to invoke `onAuthorityRevoked` on and this 403 used to leave no trace whatsoever — the
    // same security denial, invisible in the log. Emit the catalogued op here too, so an admission
    // denial and a mid-stream revocation are both reconstructable and told apart by `phase`.
    recordWatchAuthorityRevoked(ctx, root.realRoot, "admission");
    return { status: 403, body: errorBody("DENIED", "Workspace watch authority is unavailable.") };
  }
  if (result.kind === "subscriberLimit") {
    return {
      status: 429,
      body: errorBody("SUBSCRIBER_LIMIT", "Too many workspace watch subscribers."),
    };
  }
  return openWatchStream(ctx, controller, result);
}
