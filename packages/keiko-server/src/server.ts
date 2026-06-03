// The local UI BFF binds 127.0.0.1 only, applies security headers and CSP to every response,
// rejects non-loopback Host/Origin headers, dispatches API routes through injected handlers,
// and serves the static export from a contained root.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { applySecurityHeaders } from "./headers.js";
import { isAllowedHost } from "./host-check.js";
import { resolveContainedPath, serveFile } from "./static.js";
import {
  errorBody,
  isApiPath,
  matchRoute,
  methodNotAllowedBody,
  notFoundBody,
  STREAMING,
  type ApiError,
  type RouteContext,
} from "./routes.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";

export const DEFAULT_UI_PORT = 1983;
export const UI_HOST = "127.0.0.1";

export interface UiServerDeps {
  // Absolute path to the directory holding the exported static assets (`dist/ui/static`).
  readonly staticRoot: string;
  // Precomputed CSP header value (with the static export's inline-script hashes folded in).
  readonly csp: string;
  // The port the server will bind; used to validate the request `Host`/`Origin` authority.
  readonly port: number;
  // The JSON/SSE handler dependencies. Optional: when absent the server still serves static assets
  // and the health route, and the API handlers degrade gracefully (null config, empty evidence).
  readonly handlerDeps?: UiHandlerDeps | undefined;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isJsonRequest(req: IncomingMessage): boolean {
  const header = req.headers["content-type"];
  const value = typeof header === "string" ? header : header?.[0];
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasCsrfHeader(req: IncomingMessage): boolean {
  const header = req.headers["x-keiko-csrf"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === "1";
}

function rejectUnsupportedMediaType(res: ServerResponse): void {
  writeJson(
    res,
    415,
    errorBody("UNSUPPORTED_MEDIA_TYPE", "State-changing API requests must use JSON."),
  );
}

function rejectCsrf(res: ServerResponse): void {
  writeJson(res, 403, errorBody("FORBIDDEN_CSRF", "Missing state-changing request guard."));
}

// A minimal default deps object so a 3-arg server can still serve the deps-bound read routes (e.g.
// `/api/models` and `/api/workspace`, which need no config) without a config or evidence dir. The
// fallback UI store is in-memory: a 3-arg server is used by the Wave 1 host smoke and by tests that
// never exercise the store routes, so an ephemeral in-memory store is the safe degraded shape.
function fallbackDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function isStateChangingMethod(method: string): boolean {
  return (
    method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE"
  );
}

// Returns true when the request was rejected (caller should return immediately).
function rejectIfInvalidStateChange(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isJsonRequest(req)) {
    rejectUnsupportedMediaType(res);
    return true;
  }
  if (!hasCsrfHeader(req)) {
    rejectCsrf(res);
    return true;
  }
  return false;
}

async function dispatchApi(
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const match = matchRoute(method, url.pathname);
  if (match === undefined) {
    writeJson(res, 404, notFoundBody());
    return;
  }
  if (match === "method-not-allowed") {
    writeJson(res, 405, methodNotAllowedBody());
    return;
  }
  if (isStateChangingMethod(method) && rejectIfInvalidStateChange(req, res)) {
    return;
  }
  const ctx: RouteContext = { req, res, params: match.params, url };
  const outcome = await match.definition.handler(ctx, handlerDeps);
  if (outcome === STREAMING) {
    return;
  }
  writeJson(res, outcome.status, outcome.body);
}

async function serveStatic(
  res: ServerResponse,
  staticRoot: string,
  pathname: string,
): Promise<void> {
  const targets =
    pathname === "/"
      ? ["/index.html"]
      : extname(pathname) === ""
        ? [pathname, `${pathname}.html`, `${pathname}/index.html`]
        : [pathname];
  for (const target of targets) {
    const resolved = resolveContainedPath(staticRoot, target);
    if (resolved !== undefined && (await serveFile(res, resolved))) {
      return;
    }
  }
  const indexPath = join(staticRoot, "index.html");
  if (await serveFile(res, indexPath)) {
    return;
  }
  writeJson(res, 404, errorBody("NOT_FOUND", "The requested resource was not found."));
}

function rejectForbiddenHost(res: ServerResponse): void {
  const body: ApiError = errorBody("FORBIDDEN_HOST", "Request host is not the local interface.");
  writeJson(res, 403, body);
}

function handle(
  deps: UiServerDeps,
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? "/", `http://${UI_HOST}`);
  const apiPath = isApiPath(url.pathname);
  applySecurityHeaders(res, deps.csp, apiPath);
  if (!isAllowedHost(req, deps.port)) {
    rejectForbiddenHost(res);
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const work = apiPath
    ? dispatchApi(handlerDeps, req, res, method, url)
    : serveStatic(res, deps.staticRoot, url.pathname);
  void work.catch(() => {
    if (!res.headersSent) {
      writeJson(res, 500, errorBody("INTERNAL", "An unexpected error occurred."));
    } else {
      res.end();
    }
  });
}

// Creates the BFF server. The caller binds it with `server.listen(deps.port, UI_HOST)` so it never
// listens on a non-loopback interface. The previous PTY WebSocket upgrade handler is removed —
// the terminal tool is now bounded-exec over plain HTTP (ADR-0018 D1/D8).
export function createUiServer(deps: UiServerDeps): Server {
  const handlerDeps = deps.handlerDeps ?? fallbackDeps();
  const server = createServer((req, res) => {
    handle(deps, handlerDeps, req, res);
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  return server;
}
