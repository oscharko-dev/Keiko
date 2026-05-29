// BFF route dispatch skeleton (ADR-0011 D5). The eleven-route contract is wired here; Wave 1
// implements only `GET /api/health`. Every other route is registered and returns a 501
// NOT_IMPLEMENTED placeholder so the contract surface is explicit and Wave 2 fills the handlers.
// Responses are the redacted error envelope `{ error: { code, message } }` for non-2xx.

import type { IncomingMessage } from "node:http";
import { SDK_VERSION } from "../sdk/index.js";

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

// A route handler returns the HTTP status and the JSON body to serialize. Handlers are pure with
// respect to the response object: the server writes status, headers, and body.
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly params: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

export interface RouteDefinition {
  readonly method: string;
  // Path template with `:name` segments captured into `RouteContext.params`.
  readonly pattern: string;
  readonly handler: RouteHandler;
}

function notImplemented(): RouteResult {
  return {
    status: 501,
    body: {
      error: { code: "NOT_IMPLEMENTED", message: "This route is implemented in a later wave." },
    } satisfies ApiError,
  };
}

function health(): RouteResult {
  return { status: 200, body: { status: "ok", version: SDK_VERSION } };
}

// The full eleven-route contract (D5). Order is the contract order; `/api/health` is the only live
// handler in Wave 1.
export const API_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/health", handler: health },
  { method: "GET", pattern: "/api/config", handler: notImplemented },
  { method: "GET", pattern: "/api/models", handler: notImplemented },
  { method: "GET", pattern: "/api/workflows", handler: notImplemented },
  { method: "POST", pattern: "/api/runs", handler: notImplemented },
  { method: "GET", pattern: "/api/runs/:runId/events", handler: notImplemented },
  { method: "POST", pattern: "/api/runs/:runId/cancel", handler: notImplemented },
  { method: "GET", pattern: "/api/runs/:runId", handler: notImplemented },
  { method: "POST", pattern: "/api/runs/:runId/apply", handler: notImplemented },
  { method: "GET", pattern: "/api/evidence", handler: notImplemented },
  { method: "GET", pattern: "/api/evidence/:runId", handler: notImplemented },
];

// Matches a concrete path against a route pattern, capturing `:name` params. Returns the captured
// params, or undefined when the segment counts differ or a literal segment mismatches.
function matchPattern(
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i] ?? "";
    const actual = pathParts[i] ?? "";
    if (p.startsWith(":")) {
      if (actual.length === 0) {
        return undefined;
      }
      params[p.slice(1)] = actual;
    } else if (p !== actual) {
      return undefined;
    }
  }
  return params;
}

export interface RouteMatch {
  readonly definition: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

// Resolves a method+path to a route. Returns `{ definition, params }` on a full match, the string
// `"method-not-allowed"` when the path matches a route of a different method, or undefined when no
// route path matches at all.
export function matchRoute(
  method: string,
  pathname: string,
): RouteMatch | "method-not-allowed" | undefined {
  let pathMatchedOtherMethod = false;
  for (const definition of API_ROUTES) {
    const params = matchPattern(definition.pattern, pathname);
    if (params === undefined) {
      continue;
    }
    if (definition.method === method) {
      return { definition, params };
    }
    pathMatchedOtherMethod = true;
  }
  return pathMatchedOtherMethod ? "method-not-allowed" : undefined;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}

// Re-exported for callers that build responses (the server writes these to the API response).
export function notFoundBody(): ApiError {
  return errorBody("NOT_FOUND", "The requested resource was not found.");
}

export function methodNotAllowedBody(): ApiError {
  return errorBody("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this resource.");
}
