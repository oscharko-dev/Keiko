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
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteResult,
} from "../routes.js";
import { SSE_HEADERS } from "../sse.js";
import {
  APP_SESSION_COOKIE_MAX_AGE_SECONDS,
  clearSessionCookies,
  readSessionCookie,
  requestIsSecure,
  serializeSessionCookies,
} from "./sessionCookie.js";

const MAX_PAIRING_BODY_BYTES = 8 * 1_024;

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
  return result.paired ? ackResult(issuedCookie(ctx.req, result.cookieToken)) : ackResult();
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
  );
  return STREAMING;
}

export function openCodingAppSessionStream(
  res: ServerResponse,
  req: IncomingMessage,
  channel: UiHandlerDeps["codingAppSessionChannel"],
  cookieToken: string | undefined,
): void {
  res.writeHead(200, SSE_HEADERS);
  const write = (snapshot: CodingAppSessionChannelSnapshot): boolean =>
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  if (channel === undefined) {
    write(contentFreeCodingAppSessionChannelSnapshot());
    res.end();
    return;
  }
  let closeStream = (): void => undefined;
  const subscription = channel.subscribe(cookieToken, (snapshot): boolean => {
    const accepted = write(snapshot);
    if (!accepted || snapshot.content === null) queueMicrotask(closeStream);
    return accepted && snapshot.content !== null;
  });
  if (!write(subscription.snapshot) || !subscription.live) {
    subscription.detach();
    res.end();
    return;
  }
  const heartbeat = setInterval(() => {
    if (!res.write(": heartbeat\n\n")) res.destroy();
  }, 15_000);
  heartbeat.unref();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscription.detach();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  closeStream = close;
  res.once("close", close);
  req.once("aborted", close);
}

/** POST /rotate — rotate the presented session's secret; the prior cookie stops working. */
export function handleCodingAppSessionRotate(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const channel = deps.codingAppSessionChannel;
  if (channel === undefined) return ackResult();
  const result = channel.rotate(readSessionCookie(ctx.req));
  return result.rotated ? ackResult(issuedCookie(ctx.req, result.cookieToken)) : ackResult();
}

/** POST /sign-out — revoke the presented session and clear the cookie. */
export function handleCodingAppSessionSignOut(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  deps.codingAppSessionChannel?.signOut(readSessionCookie(ctx.req));
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
