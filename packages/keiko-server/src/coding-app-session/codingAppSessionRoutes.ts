// Routes for the authenticated local app-session channel (ADR-0141 D3, D6).
//
// This is a new authenticated surface, distinct from the permanently content-free coding-runtime
// status/`EventSource` routes; it does not widen their SSE union. POST routes inherit the central
// loopback/Origin/CSRF/JSON enforcement in server.ts (defense in depth); the session cookie is the
// read authority the channel enforces on top. Every read fails closed to the byte-identical
// content-free projection — never a 401/403 that would reveal whether protected content exists.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  codingAppSessionAcknowledgement,
  contentFreeCodingAppSessionChannelSnapshot,
  type CodingAppSessionChannelSnapshot,
} from "./channelContract.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  emitServerDiagnostic,
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteResult,
} from "../routes.js";
import { SSE_HEADERS } from "../sse.js";
import { createSessionStreamWriter, createSessionStreamTransport } from "./sessionStreamWriter.js";
import { resolveCodingAppSessionDenialWindows } from "./denialWindows.js";
import {
  APP_SESSION_COOKIE_MAX_AGE_SECONDS,
  clearSessionCookies,
  readSessionCookie,
  requestIsSecure,
  serializeSessionCookies,
} from "./sessionCookie.js";

const MAX_PAIRING_BODY_BYTES = 8 * 1_024;
export const CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS = 1_000;

// KEIKO-0838: rate-limited aggregate diagnostic for pairing/rotate denials so an operator can
// notice a systemic launcher-pairing failure without turning each attempt into a pairing-attempt
// oracle. The window is coarse (60 s) and the threshold is high enough to avoid emitting on
// isolated retries; only when denials cluster (>= DENIAL_ALERT_THRESHOLD in one window) do we
// emit ONE aggregate ServerDiagnosticRecord carrying just the occurrenceCount -- never per-
// attempt detail (no attestation content, no cookie tokens, no session ids, no timestamps). The
// window counters themselves are graph-scoped (denialWindows.ts, #2906 round 3) rather than module
// globals, so two independently composed `UiHandlerDeps` graphs never share or cross-pollute counts.
function emitPairingDenialAggregate(
  deps: UiHandlerDeps,
  operation: "coding-app-session.pair" | "coding-app-session.rotate",
  count: number,
): void {
  if (deps.diagnostics === undefined) return;
  emitServerDiagnostic(deps.diagnostics, {
    // No single request owns this aggregate (it summarizes many denied attempts across the
    // window), so there is no per-request correlation id to thread -- UNKNOWN_CORRELATION_ID is
    // the sanctioned shape-valid stand-in. An empty string is not a valid correlation id and is
    // rewritten to INVALID_CORRELATION_ID_MARKER by the sanitizer, which is indistinguishable from
    // a hostile producer value and breaks support-timeline joins for this diagnostic.
    correlationId: UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation,
    source: "coding-app-session-routes",
    errorClass: "PairingDenialsExceeded",
    message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
    occurrenceCount: count,
  });
}

// F65: the pairing and channel lifecycle, body-free: which step happened and for which request, and
// for a live stream how long it stayed open. A denied pairing or rotation writes no line of its own;
// it stays in the rate-limited aggregate above (KEIKO-0838).
function appSessionActivity(deps: UiHandlerDeps): ServerLogSink {
  return deps.activityLog ?? processServerLogSink();
}

function channelOpened(
  activityLog: ServerLogSink,
  correlationId: string | undefined,
  live: boolean,
): () => void {
  const openedAt = Date.now();
  const correlation = correlationId ?? UNKNOWN_CORRELATION_ID;
  activityLog.write({
    level: "info",
    category: "http",
    op: "coding-app-session.channel.opened",
    correlationId: correlation,
    extra: { live },
  });
  return (): void => {
    activityLog.write({
      level: "info",
      category: "http",
      op: "coding-app-session.channel.closed",
      correlationId: correlation,
      durationMs: Date.now() - openedAt,
    });
  };
}

/** Read and JSON-parse a bounded request body, resolving `undefined` on any failure (fail closed). */
export function readPairingBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve): void => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: unknown): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    req.on("data", (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_PAIRING_BODY_BYTES) {
        finish(undefined);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        finish(undefined);
        return;
      }
      try {
        finish(JSON.parse(raw));
      } catch {
        finish(undefined);
      }
    });
    req.on("error", (): void => {
      finish(undefined);
    });
  });
}

function ackResult(headers?: RouteResult["headers"]): RouteResult {
  const body = codingAppSessionAcknowledgement();
  return headers ? { status: 200, body, headers } : { status: 200, body };
}

function issuedCookie(
  req: IncomingMessage,
  cookieToken: string,
): Readonly<Record<string, readonly string[]>> {
  return {
    "Set-Cookie": serializeSessionCookies(cookieToken, {
      secure: requestIsSecure(req),
      maxAgeSeconds: APP_SESSION_COOKIE_MAX_AGE_SECONDS,
    }),
  };
}

/** POST /pair — issue a session when the pairing port approves the launcher attestation. */
export async function handleCodingAppSessionPair(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const channel = deps.codingAppSessionChannel;
  if (channel === undefined) return ackResult();
  const attestation = await readPairingBody(ctx.req);
  const result = channel.pair(attestation);
  if (!result.paired) {
    // KEIKO-0838: aggregate denials into one rate-limited, count-only diagnostic per window.
    resolveCodingAppSessionDenialWindows(deps).recordPairingDenial(Date.now(), (count) => {
      emitPairingDenialAggregate(deps, "coding-app-session.pair", count);
    });
    return ackResult();
  }
  appSessionActivity(deps).write({
    level: "info",
    category: "http",
    op: "coding-app-session.paired",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
  });
  return ackResult(issuedCookie(ctx.req, result.cookieToken));
}

function currentSnapshot(
  deps: UiHandlerDeps,
  req: IncomingMessage,
): CodingAppSessionChannelSnapshot {
  const channel = deps.codingAppSessionChannel;
  return channel === undefined
    ? contentFreeCodingAppSessionChannelSnapshot()
    : channel.snapshot(readSessionCookie(req));
}

/** GET /channel — authenticated snapshot read; content-free for an unpaired caller (fail closed). */
export function handleCodingAppSessionChannelSnapshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  return { status: 200, body: currentSnapshot(deps, ctx.req) };
}

/** GET /channel/stream — authenticated fetch-streamed read. Never the content-free EventSource union. */
export function handleCodingAppSessionChannelStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): HandlerOutcome {
  openCodingAppSessionStream(
    ctx.res,
    ctx.req,
    deps.codingAppSessionChannel,
    readSessionCookie(ctx.req),
    ctx.correlationId,
    deps.diagnostics,
    appSessionActivity(deps),
  );
  return STREAMING;
}

function bindLiveStreamDrain(
  res: ServerResponse,
  req: IncomingMessage,
  stop: () => void,
  detach: () => void,
  heartbeat: ReturnType<typeof setInterval>,
): () => void {
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    detach();
  };
  const drain = (): void => {
    clearInterval(heartbeat);
    stop();
    if (!res.writableEnded && !res.destroyed) res.end();
    if (released || res.destroyed || res.writableFinished || drainTimer !== undefined) return;
    drainTimer = setTimeout(() => {
      if (!res.destroyed && !res.writableFinished) res.destroy();
    }, CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS);
    drainTimer.unref();
  };
  res.once("finish", (): void => {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
  });
  res.once("close", release);
  req.once("aborted", (): void => {
    if (!res.destroyed) res.destroy();
  });
  return drain;
}

export function openCodingAppSessionStream(
  res: ServerResponse,
  req: IncomingMessage,
  channel: UiHandlerDeps["codingAppSessionChannel"],
  cookieToken: string | undefined,
  correlationId?: string,
  diagnostics?: ServerDiagnosticSink,
  activityLog: ServerLogSink = processServerLogSink(),
): void {
  res.writeHead(200, SSE_HEADERS);
  const transport = createSessionStreamTransport(res, correlationId, diagnostics);
  if (channel === undefined) {
    channelOpened(activityLog, correlationId, false);
    transport.write(contentFreeCodingAppSessionChannelSnapshot());
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  let closeStream = (): void => undefined;
  const writer = createSessionStreamWriter(
    res,
    () => {
      closeStream();
    },
    correlationId,
  );
  const subscription = channel.subscribe(cookieToken, writer.publish, {
    deferAdmissionReleaseOnBackpressure: true,
  });
  if (writer.isClosing() || !transport.write(subscription.snapshot) || !subscription.live) {
    channelOpened(activityLog, correlationId, false);
    subscription.detach();
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  const closed = channelOpened(activityLog, correlationId, true);
  const detach = (): void => {
    subscription.detach();
    closed();
  };
  const heartbeat = setInterval(transport.heartbeat, 15_000);
  heartbeat.unref();
  closeStream = bindLiveStreamDrain(res, req, subscription.stop, detach, heartbeat);
}

/** POST /rotate — rotate the presented session's secret; the prior cookie stops working. */
export function handleCodingAppSessionRotate(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const channel = deps.codingAppSessionChannel;
  if (channel === undefined) return ackResult();
  const result = channel.rotate(readSessionCookie(ctx.req));
  if (!result.rotated) {
    // KEIKO-0838: same aggregate-diagnostic pattern as pair(), independent window/counter.
    resolveCodingAppSessionDenialWindows(deps).recordRotateDenial(Date.now(), (count) => {
      emitPairingDenialAggregate(deps, "coding-app-session.rotate", count);
    });
    return ackResult();
  }
  appSessionActivity(deps).write({
    level: "info",
    category: "http",
    op: "coding-app-session.rotated",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
  });
  return ackResult(issuedCookie(ctx.req, result.cookieToken));
}

/** POST /sign-out — revoke the presented session and clear the cookie. */
export function handleCodingAppSessionSignOut(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  // Only a sign-out that revoked a session is logged, as only a rotation that rotated one is: an
  // absent or unknown cookie, or a repeated sign-out from a stale tab, revoked nothing, and the
  // response is the same either way (PR #3452 review).
  if (deps.codingAppSessionChannel?.signOut(readSessionCookie(ctx.req)) === true) {
    appSessionActivity(deps).write({
      level: "info",
      category: "http",
      op: "coding-app-session.signed-out",
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    });
  }
  return ackResult({ "Set-Cookie": clearSessionCookies(requestIsSecure(ctx.req)) });
}

export const CODING_APP_SESSION_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/pair",
    handler: handleCodingAppSessionPair,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/app-session/channel",
    handler: handleCodingAppSessionChannelSnapshot,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/app-session/channel/stream",
    handler: handleCodingAppSessionChannelStream,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/rotate",
    handler: handleCodingAppSessionRotate,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/sign-out",
    handler: handleCodingAppSessionSignOut,
  },
];
