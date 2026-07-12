import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FEEDBACK_MAINTAINER_CSRF_HEADER_V1,
  FEEDBACK_MAINTAINER_OIDC_COOKIE_V1,
  type FeedbackMaintainerPermissionV1,
} from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import {
  FEEDBACK_REVIEW_STATES_V1,
  type FeedbackReviewStateV1,
} from "@oscharko-dev/keiko-contracts/feedback-review";
import { parseMaintainerAction, permissionForAction } from "./maintainer-action.js";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import type { PostgresFeedbackReviewQuery } from "./feedback-review-query.js";
import type { PostgresFeedbackReviewRepository } from "./feedback-review-store.js";
import type { MaintainerAuthService } from "./maintainer-auth.js";
import { readMaintainerBody } from "./maintainer-http-body.js";
import { mapMaintainerError } from "./maintainer-http-error.js";
import type { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";
import {
  clearSessionCookie,
  boundedLimit,
  cookie,
  duplicateHeader,
  fail,
  json,
  securityHeaders,
  setCookie,
  setSessionCookie,
  type MaintainerDiagnostics,
} from "./maintainer-http-response.js";
import { maintainerCsrfToken, verifyMaintainerCsrf } from "./maintainer-store.js";
import {
  handleMaintainerPublication,
  type MaintainerPublicationService,
} from "./maintainer-publication-http.js";
import { serveMaintainerUi } from "./maintainer-ui.js";
import { resolveClientAddress, type ClientAddressInput } from "./proxy.js";

export interface MaintainerHttpOptions {
  readonly publicOrigin: string;
  readonly auth: MaintainerAuthService;
  readonly query: Pick<PostgresFeedbackReviewQuery, "list" | "detail" | "hold" | "audit">;
  readonly review: Pick<PostgresFeedbackReviewRepository, "execute">;
  readonly publication?: MaintainerPublicationService | undefined;
  readonly publicationTargets?:
    | readonly import("@oscharko-dev/keiko-contracts/feedback-maintainer").FeedbackPublicationTargetCatalogItemV1[]
    | undefined;
  readonly loginLimiter: MaintainerLoginLimiter;
  readonly proxy: Pick<ClientAddressInput, "family" | "trustedCidrs" | "maxHops">;
  readonly legalHoldPolicyKeys?: readonly string[] | undefined;
  readonly diagnostics?: MaintainerDiagnostics | undefined;
}

type Session = NonNullable<Awaited<ReturnType<MaintainerAuthService["session"]>>>;

function permits(identity: Session, permission: FeedbackMaintainerPermissionV1): boolean {
  return identity.permissions.includes(permission);
}

function validCsrf(
  req: IncomingMessage,
  identity: Session,
  options: MaintainerHttpOptions,
): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  if (duplicateHeader(req, "origin") || duplicateHeader(req, FEEDBACK_MAINTAINER_CSRF_HEADER_V1))
    return false;
  if (duplicateHeader(req, "content-type")) return false;
  if (req.headers.origin !== options.publicOrigin) return false;
  if (req.headers["content-type"]?.toLowerCase() !== "application/json") return false;
  const token = req.headers[FEEDBACK_MAINTAINER_CSRF_HEADER_V1];
  return typeof token === "string" && verifyMaintainerCsrf(token, identity.csrfHash);
}

function loginSource(req: IncomingMessage, options: MaintainerHttpOptions): Uint8Array | undefined {
  if (duplicateHeader(req, "forwarded") || duplicateHeader(req, "x-forwarded-for")) {
    return undefined;
  }
  const peer = req.socket.remoteAddress;
  if (peer === undefined) return undefined;
  const forwarded = req.headers.forwarded;
  const xForwardedFor = req.headers["x-forwarded-for"];
  const result = resolveClientAddress({
    peer,
    forwarded: typeof forwarded === "string" ? forwarded : undefined,
    xForwardedFor: typeof xForwardedFor === "string" ? xForwardedFor : undefined,
    ...options.proxy,
  });
  return result.ok ? result.bytes : undefined;
}

async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/maintainer/auth/login") {
    await handleLogin(req, res, options);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/v1/maintainer/auth/callback") {
    const browserCapability = cookie(req, FEEDBACK_MAINTAINER_OIDC_COOKIE_V1);
    if (browserCapability === undefined) {
      fail(res, 400);
      return true;
    }
    try {
      const created = await options.auth.callback(url, browserCapability, cookie(req));
      setCookie(res, FEEDBACK_MAINTAINER_OIDC_COOKIE_V1, "", 0);
      setSessionCookie(
        res,
        created.capability,
        Math.max(1, Math.floor((created.absoluteExpiresAt.getTime() - Date.now()) / 1_000)),
      );
      res.writeHead(303, { ...securityHeaders(), Location: `${options.publicOrigin}/maintainer/` });
      res.end();
    } catch (error) {
      setCookie(res, FEEDBACK_MAINTAINER_OIDC_COOKIE_V1, "", 0);
      throw error;
    }
    return true;
  }
  return false;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: MaintainerHttpOptions,
): Promise<void> {
  const source = loginSource(req, options);
  if (source === undefined) {
    fail(res, 400);
    return;
  }
  const admission = options.loginLimiter.begin(source);
  if (!admission.ok) {
    fail(res, 429, { "Retry-After": String(admission.retryAfterSeconds) });
    return;
  }
  try {
    const login = await options.auth.login();
    setCookie(res, FEEDBACK_MAINTAINER_OIDC_COOKIE_V1, login.browserCapability, 300);
    res.writeHead(302, { ...securityHeaders(), Location: login.url.href });
    res.end();
  } finally {
    admission.release();
  }
}

async function handleAuthenticated(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
  capability: string,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/v1/maintainer/auth/session") {
    json(res, 200, {
      permissions:
        options.publication === undefined
          ? identity.permissions.filter((permission) => permission !== "feedback.publish")
          : identity.permissions,
      csrfToken: maintainerCsrfToken(capability),
      absoluteExpiresAt: identity.absoluteExpiresAt.toISOString(),
      ...(permits(identity, "feedback.legal-hold")
        ? { legalHoldPolicyKeys: options.legalHoldPolicyKeys ?? [] }
        : {}),
      ...(options.publicationTargets !== undefined &&
      permits(identity, "feedback.review") &&
      permits(identity, "feedback.publish")
        ? { publicationTargets: options.publicationTargets }
        : {}),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/maintainer/auth/logout") {
    if (!validCsrf(req, identity, options)) {
      fail(res, 403);
      return;
    }
    await options.auth.logout(capability);
    clearSessionCookie(res);
    json(res, 200, { status: "closed" });
    return;
  }
  await handleReview(req, res, url, options, identity);
}

async function handleReview(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
): Promise<void> {
  if (
    await handleMaintainerPublication(req, res, url, options.publication, identity, () =>
      validCsrf(req, identity, options),
    )
  )
    return;
  if (await handleCollection(req, res, url, options, identity)) return;
  await handleReviewItem(req, res, url, options, identity);
}

async function handleCollection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
): Promise<boolean> {
  if (await handleList(req, res, url, options, identity)) return true;
  return handleAudit(req, res, url, options, identity);
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/maintainer/reviews") {
    if (!permits(identity, "feedback.review")) {
      fail(res, 403);
      return true;
    }
    const state = url.searchParams.get("state") ?? undefined;
    const limit = boundedLimit(url.searchParams.get("limit"));
    if (
      limit === undefined ||
      (state !== undefined && !FEEDBACK_REVIEW_STATES_V1.includes(state as FeedbackReviewStateV1))
    ) {
      fail(res, 400);
      return true;
    }
    const items = await options.query.list({
      state: state as FeedbackReviewStateV1 | undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
      includePrivate: permits(identity, "feedback.security"),
    });
    json(res, 200, items);
    return true;
  }
  return false;
}

async function handleAudit(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/maintainer/audit") {
    if (!permits(identity, "feedback.audit")) {
      fail(res, 403);
      return true;
    }
    const limit = boundedLimit(url.searchParams.get("limit"));
    if (limit === undefined) {
      fail(res, 400);
      return true;
    }
    json(res, 200, {
      events: await options.query.audit(limit, permits(identity, "feedback.security")),
    });
    return true;
  }
  return false;
}

async function handleReviewItem(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
): Promise<void> {
  const match = /^\/v1\/maintainer\/reviews\/([^/]+)(?:\/(actions|hold))?$/u.exec(url.pathname);
  if (match?.[1] === undefined || !isCanonicalFeedbackReviewId(match[1])) {
    fail(res, 404);
    return;
  }
  if (req.method === "GET" && match[2] === "hold") {
    await handleHold(res, options, identity, match[1]);
    return;
  }
  if (req.method === "GET" && match[2] === undefined) {
    await handleDetail(res, options, identity, match[1]);
    return;
  }
  await handleAction(req, res, url, options, identity, match[1]);
}

async function handleHold(
  res: ServerResponse,
  options: MaintainerHttpOptions,
  identity: Session,
  itemId: string,
): Promise<void> {
  if (!permits(identity, "feedback.legal-hold")) {
    fail(res, 403);
    return;
  }
  const hold = await options.query.hold(itemId, permits(identity, "feedback.security"));
  if (hold === undefined) fail(res, 404);
  else json(res, 200, hold);
}

async function handleDetail(
  res: ServerResponse,
  options: MaintainerHttpOptions,
  identity: Session,
  itemId: string,
): Promise<void> {
  if (!permits(identity, "feedback.review")) {
    fail(res, 403);
    return;
  }
  const detail = await options.query.detail(itemId, permits(identity, "feedback.security"));
  if (detail === undefined) fail(res, 404);
  else json(res, 200, detail);
  return;
}

async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: MaintainerHttpOptions,
  identity: Session,
  itemId: string,
): Promise<void> {
  if (req.method !== "POST" || !url.pathname.endsWith("/actions")) {
    fail(res, 405);
    return;
  }
  if (!validCsrf(req, identity, options)) {
    fail(res, 403);
    return;
  }
  const command = parseMaintainerAction(await readMaintainerBody(req), itemId, {
    issuer: identity.issuer,
    subject: identity.subject,
    permissionPolicyVersion: identity.permissionPolicyVersion,
  });
  if (command === undefined) {
    fail(res, 400);
    return;
  }
  if (!permits(identity, permissionForAction(command))) {
    fail(res, 403);
    return;
  }
  json(res, 200, await options.review.execute(command, permits(identity, "feedback.security")));
}

export function createMaintainerHttpHandler(options: MaintainerHttpOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const correlationId = randomUUID();
    res.setHeader("X-Correlation-ID", correlationId);
    try {
      await dispatchMaintainer(req, res, options);
    } catch (error) {
      if (res.headersSent) return;
      const mapped = mapMaintainerError(error);
      options.diagnostics?.event(mapped.category, correlationId);
      fail(res, mapped.status);
    }
  };
}

async function dispatchMaintainer(
  req: IncomingMessage,
  res: ServerResponse,
  options: MaintainerHttpOptions,
): Promise<void> {
  const target = req.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) {
    fail(res, 400);
    return;
  }
  const url = new URL(target, options.publicOrigin);
  if (await serveMaintainerUi(req.method, url.pathname, res, acceptEncoding(req))) return;
  if (!url.pathname.startsWith("/v1/maintainer/")) {
    fail(res, 404);
    return;
  }
  if (await handleAuth(req, res, url, options)) return;
  const capability = cookie(req);
  if (capability === undefined) {
    fail(res, 401);
    return;
  }
  const identity = await options.auth.session(capability);
  if (identity === undefined) {
    fail(res, 401);
    return;
  }
  await handleAuthenticated(req, res, url, options, identity, capability);
}

function acceptEncoding(req: IncomingMessage): string | undefined {
  if (duplicateHeader(req, "accept-encoding")) return undefined;
  const value = req.headers["accept-encoding"];
  return typeof value === "string" ? value : undefined;
}
