// BFF route dispatch (ADR-0011 D5). The eleven-route contract is wired here. The route TABLE
// (method + pattern) is static and dependency-free; each entry names a handler that receives the
// request context AND the per-server handler dependencies (resolved config, evidence store, run
// registry, redactor — see deps.ts). A handler returns a RouteResult (status + JSON body, which the
// server serializes) OR the STREAMING sentinel, meaning it has taken over the raw ServerResponse
// (the SSE events route). Non-2xx bodies use the redacted error envelope `{ error: { code, message } }`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SDK_VERSION } from "../sdk/index.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  handleConfig,
  handleModels,
  handleWorkflows,
  handleEvidenceList,
  handleEvidenceDetail,
} from "./read-handlers.js";
import {
  handleCreateRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

// A route handler returns the HTTP status and the JSON body to serialize, or STREAMING when it has
// written directly to the ServerResponse (SSE) and the server must not write a JSON body.
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export const STREAMING = Symbol("streaming");
export type HandlerOutcome = RouteResult | typeof STREAMING;

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  // Parsed request URL (loopback-authority base); handlers read the query without re-parsing.
  readonly url: URL;
}

export type RouteHandler = (
  ctx: RouteContext,
  deps: UiHandlerDeps,
) => HandlerOutcome | Promise<HandlerOutcome>;

export interface RouteDefinition {
  readonly method: string;
  // Path template with `:name` segments captured into `RouteContext.params`.
  readonly pattern: string;
  readonly handler: RouteHandler;
}

function health(): RouteResult {
  return { status: 200, body: { status: "ok", version: SDK_VERSION } };
}

// The full eleven-route contract (D5), in contract order.
export const API_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/health", handler: health },
  { method: "GET", pattern: "/api/config", handler: handleConfig },
  { method: "GET", pattern: "/api/models", handler: handleModels },
  { method: "GET", pattern: "/api/workflows", handler: handleWorkflows },
  { method: "POST", pattern: "/api/runs", handler: handleCreateRun },
  { method: "GET", pattern: "/api/runs/:runId/events", handler: handleRunEvents },
  { method: "POST", pattern: "/api/runs/:runId/cancel", handler: handleCancelRun },
  { method: "GET", pattern: "/api/runs/:runId", handler: handleGetRun },
  { method: "POST", pattern: "/api/runs/:runId/apply", handler: handleApplyRun },
  { method: "GET", pattern: "/api/evidence", handler: handleEvidenceList },
  { method: "GET", pattern: "/api/evidence/:runId", handler: handleEvidenceDetail },
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

export function notFoundBody(): ApiError {
  return errorBody("NOT_FOUND", "The requested resource was not found.");
}

export function methodNotAllowedBody(): ApiError {
  return errorBody("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this resource.");
}
