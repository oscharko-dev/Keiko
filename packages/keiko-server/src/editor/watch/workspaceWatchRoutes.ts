import type { ServerResponse } from "node:http";

import type {
  EditorM7SettingsSnapshot,
  EditorM7WatchEvent,
  EditorM7WatchSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { resolveRoot, runFilesHandler } from "../../files.js";
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

async function resolveRealRoot(ctx: RouteContext, deps: UiHandlerDeps): Promise<string> {
  const resolved = await resolveRoot(deps.store, ctx.url.searchParams.get("root"), deps.redactor);
  return resolved.realRoot;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function watcherExclusionsFrom(snapshot: EditorM7SettingsSnapshot): readonly string[] {
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
): Promise<RouteResult | { readonly ok: true; readonly root: string }> {
  const result = await runFilesHandler(async () => ({
    status: 200,
    body: { root: await resolveRealRoot(ctx, deps) },
  }));
  if (result.status !== 200) return result;
  const body = result.body as { readonly root: string };
  return { ok: true, root: body.root };
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
    body: service.snapshot(await resolveRealRoot(ctx, deps)),
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
  const additionalExclusions = await resolveAdditionalExclusions(deps, resolved.root);
  const controller = new AbortController();
  const result = service.subscribe({
    root: resolved.root,
    lastSequence: parseLastSequence(ctx),
    onEvent: (event) => writeOrDestroy(ctx.res, frameWatchEvent(event), controller),
    additionalExclusions,
  });
  if (result.kind === "subscriberLimit") {
    return {
      status: 429,
      body: errorBody("SUBSCRIBER_LIMIT", "Too many workspace watch subscribers."),
    };
  }
  return openWatchStream(ctx, controller, result);
}
