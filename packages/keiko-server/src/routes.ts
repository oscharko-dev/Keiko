// BFF route dispatch (ADR-0011 D5). The route contract is wired here. The route TABLE
// (method + pattern) is static and dependency-free; each entry names a handler that receives the
// request context AND the per-server handler dependencies (resolved config, evidence store, run
// registry, redactor — see deps.ts). A handler returns a RouteResult (status + JSON body, which the
// server serializes) OR the STREAMING sentinel, meaning it has taken over the raw ServerResponse
// (the SSE events route). Non-2xx bodies use the redacted error envelope `{ error: { code, message } }`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SDK_VERSION } from "./_sdk-version.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  handleConfig,
  handleModels,
  handleWorkflows,
  handleWorkspace,
  handleEvidenceList,
  handleEvidenceDetail,
} from "./read-handlers.js";
import {
  handleCreateRun,
  handleCreateChatRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";
import {
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
  handleListChats,
  handleCreateChat,
  handleUpdateChat,
  handleDeleteChat,
  handleListMessages,
  handleCreateMessage,
  handleCreateRunSummaryPair,
  handleUpdateMessage,
} from "./store-handlers.js";
import { handleCreateDesktopChat, handleSendDesktopChat } from "./chat-handlers.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import {
  handleCreateTerminalExecution,
  handleDeleteTerminalExecution,
  handleTerminalDirectories,
  handleTerminalEvents,
  handleTerminalPolicy,
} from "./terminal-routes.js";
import { handleFilesDirectories, handleFilesPreview, handleFilesTree } from "./files.js";
import {
  handleBrowserApplyScreenshot,
  handleBrowserContent,
  handleBrowserEvents,
  handleBrowserNavigate,
  handleBrowserScreenshot,
  handleBrowserStatus,
  handleCreateBrowserSession,
  handleDeleteBrowserSession,
} from "./browser.js";

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

// The full route contract: the twelve original (ADR-0011 D5), the first-run gateway setup
// endpoint, the 10 additive UI-store routes (ADR-0013 D7), three Issue #66 run-summary routes,
// two desktop chat routes, desktop terminal JSON routes, and read-only Files widget routes.
// Terminal byte I/O uses a token-scoped WebSocket upgrade path.
export const API_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/health", handler: health },
  { method: "GET", pattern: "/api/config", handler: handleConfig },
  { method: "GET", pattern: "/api/models", handler: handleModels },
  { method: "POST", pattern: "/api/gateway/setup", handler: handleGatewaySetup },
  { method: "GET", pattern: "/api/workflows", handler: handleWorkflows },
  { method: "POST", pattern: "/api/runs", handler: handleCreateRun },
  { method: "GET", pattern: "/api/runs/:runId/events", handler: handleRunEvents },
  { method: "POST", pattern: "/api/runs/:runId/cancel", handler: handleCancelRun },
  { method: "GET", pattern: "/api/runs/:runId", handler: handleGetRun },
  { method: "POST", pattern: "/api/runs/:runId/apply", handler: handleApplyRun },
  { method: "GET", pattern: "/api/evidence", handler: handleEvidenceList },
  { method: "GET", pattern: "/api/evidence/:runId", handler: handleEvidenceDetail },
  { method: "GET", pattern: "/api/workspace", handler: handleWorkspace },
  // ADR-0013 D7 — UI-local persistence routes (additive).
  { method: "GET", pattern: "/api/projects", handler: handleListProjects },
  { method: "POST", pattern: "/api/projects", handler: handleCreateProject },
  { method: "PATCH", pattern: "/api/projects", handler: handleUpdateProject },
  { method: "DELETE", pattern: "/api/projects", handler: handleDeleteProject },
  { method: "GET", pattern: "/api/chats", handler: handleListChats },
  { method: "POST", pattern: "/api/chats", handler: handleCreateChat },
  // Issue #66 — composer launch path: persist chat pair and start the run as one BFF operation.
  { method: "POST", pattern: "/api/chats/runs", handler: handleCreateChatRun },
  { method: "PATCH", pattern: "/api/chats", handler: handleUpdateChat },
  { method: "DELETE", pattern: "/api/chats", handler: handleDeleteChat },
  { method: "GET", pattern: "/api/chats/messages", handler: handleListMessages },
  { method: "POST", pattern: "/api/chats/messages", handler: handleCreateMessage },
  // Issue #66 — atomic composer write: exactly one user message plus one run-summary system message.
  {
    method: "POST",
    pattern: "/api/chats/messages/run-summary-pair",
    handler: handleCreateRunSummaryPair,
  },
  // Issue #66 — PATCH a run-summary message (status/shortResult/taskType).
  { method: "PATCH", pattern: "/api/chats/messages", handler: handleUpdateMessage },
  // Issue #185 — grounded repository-aware Q&A. Composes #179-#183 behind the chat-scope binding.
  { method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },
  // Desktop canvas V1 — real chat against the configured gateway model without new agent scope.
  { method: "POST", pattern: "/api/desktop/chats", handler: handleCreateDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat", handler: handleSendDesktopChat },
  // ADR-0018 — bounded permitted-command execution. PTY routes (shells/sessions/WS upgrade) and
  // the WebSocket upgrade handler in server.ts are removed; commands run via synchronous POST.
  { method: "GET", pattern: "/api/terminal/policy", handler: handleTerminalPolicy },
  { method: "GET", pattern: "/api/terminal/directories", handler: handleTerminalDirectories },
  { method: "POST", pattern: "/api/terminal/executions", handler: handleCreateTerminalExecution },
  {
    method: "DELETE",
    pattern: "/api/terminal/executions/:executionId",
    handler: handleDeleteTerminalExecution,
  },
  { method: "GET", pattern: "/api/terminal/events", handler: handleTerminalEvents },
  // Desktop files — read-only selected-root browser and preview control plane.
  { method: "GET", pattern: "/api/files/directories", handler: handleFilesDirectories },
  { method: "GET", pattern: "/api/files/tree", handler: handleFilesTree },
  { method: "GET", pattern: "/api/files/preview", handler: handleFilesPreview },
  // ADR-0017 — browser tool (BYO Chrome over CDP).
  { method: "GET", pattern: "/api/browser/status", handler: handleBrowserStatus },
  { method: "POST", pattern: "/api/browser/sessions", handler: handleCreateBrowserSession },
  {
    method: "DELETE",
    pattern: "/api/browser/sessions/:sessionId",
    handler: handleDeleteBrowserSession,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/navigate",
    handler: handleBrowserNavigate,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/screenshot",
    handler: handleBrowserScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/apply",
    handler: handleBrowserApplyScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/content",
    handler: handleBrowserContent,
  },
  {
    method: "GET",
    pattern: "/api/browser/sessions/:sessionId/events",
    handler: handleBrowserEvents,
  },
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
