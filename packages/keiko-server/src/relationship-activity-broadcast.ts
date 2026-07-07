// GEN-PERF-RELACT-001 — shared per-workspace activity broadcaster for the
// GET /api/relationships/events SSE route.
//
// Before this module, every open events connection ran its OWN 5s refresh timer and its
// own snapshot sweep (up to 2 + 4×ACTIVITY_MAX_RUNS synchronous SQLite queries per tick,
// per connection), plus its own 30s ping timer — neither timer unref'd, and all four
// res.write() call sites ignored the backpressure boolean (the only SSE route in the
// server that did). K open windows multiplied the polling K-fold, and a minimized/
// throttled window grew Node's response buffer without bound.
//
// This module owns ONE refresh timer and ONE ping timer per (scope, workspaceId),
// computes each tick once, serializes each frame once, and fans the bytes out through
// writeOrDestroy so a non-draining client is aborted+destroyed instead of buffered.
// Both timers are unref'd (matching sse.ts startSseHeartbeat) so open streams never
// hold the process alive during shutdown.

import type { ServerResponse } from "node:http";
import { writeOrDestroy, type SseBackpressureSignal } from "./sse-write.js";

/** One serialized SSE frame for one activity snapshot, keyed for change detection. */
export interface ActivityFrame {
  readonly id: string;
  readonly frame: string;
}

/** Producer half: how a broadcaster computes the current frame set and how often. */
export interface ActivityBroadcastSource {
  readonly collectFrames: () => readonly ActivityFrame[];
  readonly refreshMs: number;
  readonly pingMs: number;
}

/** Consumer half: one SSE connection. Aborting the controller detaches the subscriber. */
export interface ActivitySubscriber {
  readonly res: ServerResponse;
  readonly controller: AbortController;
  readonly onBackpressure?: (signal: SseBackpressureSignal) => void;
}

interface Broadcaster {
  readonly workspaceId: string;
  readonly subscribers: Set<ActivitySubscriber>;
  // Change-detection state is broadcaster-global: frames are deterministic per snapshot
  // content (redaction included), so one diff baseline serves every subscriber.
  lastFrames: ReadonlyMap<string, string>;
  readonly source: ActivityBroadcastSource;
  readonly refresh: NodeJS.Timeout;
  readonly ping: NodeJS.Timeout;
}

// Keyed by the deps identity so parallel server instances (and test fixtures) never
// share timers or diff state; the inner map keys by workspace scope.
const registries = new WeakMap<object, Map<string, Broadcaster>>();

const PING_FRAME = `: ping\n\n`;

function writeTo(subscriber: ActivitySubscriber, frame: string): void {
  // A subscriber whose socket died mid-fan-out is skipped; its abort listener has
  // already detached it and writing to a destroyed response would throw.
  if (subscriber.controller.signal.aborted) return;
  writeOrDestroy(subscriber.res, frame, subscriber.controller, subscriber.onBackpressure);
}

function runTick(broadcaster: Broadcaster): void {
  const nextFrames = new Map<string, string>();
  for (const { id, frame } of broadcaster.source.collectFrames()) {
    nextFrames.set(id, frame);
    if (broadcaster.lastFrames.get(id) !== frame) {
      // Copy before fan-out: a backpressure kill aborts→detaches mid-iteration.
      for (const subscriber of [...broadcaster.subscribers]) writeTo(subscriber, frame);
    }
  }
  broadcaster.lastFrames = nextFrames;
}

function runPing(broadcaster: Broadcaster): void {
  for (const subscriber of [...broadcaster.subscribers]) writeTo(subscriber, PING_FRAME);
}

function ensureBroadcaster(
  scope: object,
  workspaceId: string,
  source: ActivityBroadcastSource,
): Broadcaster {
  let perScope = registries.get(scope);
  if (perScope === undefined) {
    perScope = new Map();
    registries.set(scope, perScope);
  }
  const existing = perScope.get(workspaceId);
  if (existing !== undefined) return existing;
  // The first subscriber's source closure serves the broadcaster's lifetime; all
  // subscribers of one (scope, workspaceId) observe the same deps, so the closures
  // are interchangeable by construction.
  const broadcaster: Broadcaster = {
    workspaceId,
    subscribers: new Set(),
    lastFrames: new Map(),
    source,
    refresh: setInterval((): void => {
      runTick(broadcaster);
    }, source.refreshMs).unref(),
    ping: setInterval((): void => {
      runPing(broadcaster);
    }, source.pingMs).unref(),
  };
  perScope.set(workspaceId, broadcaster);
  return broadcaster;
}

function teardownIfEmpty(scope: object, broadcaster: Broadcaster): void {
  if (broadcaster.subscribers.size > 0) return;
  clearInterval(broadcaster.refresh);
  clearInterval(broadcaster.ping);
  registries.get(scope)?.delete(broadcaster.workspaceId);
}

// Late-join emission: compute once — the full current state goes to the newcomer, any
// changes since the last tick go to the existing subscribers, and the shared diff
// baseline advances. This keeps one compute per join instead of a per-connection sweep
// while guaranteeing existing subscribers never miss a transition that happened
// between ticks.
function emitJoinState(broadcaster: Broadcaster, joiner: ActivitySubscriber): void {
  const nextFrames = new Map<string, string>();
  for (const { id, frame } of broadcaster.source.collectFrames()) {
    nextFrames.set(id, frame);
    const changed = broadcaster.lastFrames.get(id) !== frame;
    for (const subscriber of [...broadcaster.subscribers]) {
      if (subscriber === joiner || changed) writeTo(subscriber, frame);
    }
  }
  broadcaster.lastFrames = nextFrames;
}

/**
 * Attaches one SSE connection to the shared broadcaster for `workspaceId`, creating it
 * (and its two unref'd timers) on first use and tearing it down when the last
 * subscriber detaches. Returns an idempotent unsubscribe; aborting the subscriber's
 * controller (e.g. via a writeOrDestroy backpressure kill) detaches it as well.
 */
export function subscribeActivityBroadcast(
  scope: object,
  workspaceId: string,
  subscriber: ActivitySubscriber,
  source: ActivityBroadcastSource,
): () => void {
  const broadcaster = ensureBroadcaster(scope, workspaceId, source);
  let detached = false;
  const unsubscribe = (): void => {
    if (detached) return;
    detached = true;
    broadcaster.subscribers.delete(subscriber);
    teardownIfEmpty(scope, broadcaster);
  };
  subscriber.controller.signal.addEventListener("abort", unsubscribe, { once: true });
  broadcaster.subscribers.add(subscriber);
  emitJoinState(broadcaster, subscriber);
  if (subscriber.controller.signal.aborted) unsubscribe();
  return unsubscribe;
}

// Test seam: not exported via index.ts. Lets tests assert the last-subscriber teardown
// actually released the shared timers without reaching into module internals.
export function _activeBroadcastCountForTests(scope: object): number {
  return registries.get(scope)?.size ?? 0;
}
