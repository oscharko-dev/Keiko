// The Wave 2 BFF (ADR-0011 D1/D2/D5/D7/D8/D9). A hand-written node:http server with zero new runtime
// dependencies: it binds 127.0.0.1 only, sets the security headers + hash-based CSP on EVERY response
// (including the SSE and error paths), rejects non-loopback Host/Origin (DNS-rebinding defense), and
// dispatches the eleven-route API contract through deps-bound handlers. A handler returns a
// RouteResult (status + JSON body the server serializes) or the STREAMING sentinel, meaning it has
// taken over the raw ServerResponse (the SSE events route). Static export is served from a
// path-traversal-safe contained root with an index fallback. The handler dependencies (resolved
// config, evidence store, run registry, redactor) are optional so the 3-arg
// `createUiServer({ staticRoot, csp, port })` form still works (Wave 1 server tests, `keiko ui` smoke).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
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

export const DEFAULT_UI_PORT = 4319;
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

// A minimal default deps object so a 3-arg server can still serve the deps-bound read routes (e.g.
// `/api/models`, which needs no config) without a config or evidence dir.
function fallbackDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
  };
}

async function dispatchApi(
  deps: UiServerDeps,
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
  const ctx: RouteContext = { req, res, params: match.params, url };
  const handlerDeps = deps.handlerDeps ?? fallbackDeps();
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
  const target = pathname === "/" ? "/index.html" : pathname;
  const resolved = resolveContainedPath(staticRoot, target);
  if (resolved !== undefined && (await serveFile(res, resolved))) {
    return;
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

function handle(deps: UiServerDeps, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${UI_HOST}`);
  const apiPath = isApiPath(url.pathname);
  applySecurityHeaders(res, deps.csp, apiPath);
  if (!isAllowedHost(req, deps.port)) {
    rejectForbiddenHost(res);
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const work = apiPath
    ? dispatchApi(deps, req, res, method, url)
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
// listens on a non-loopback interface.
export function createUiServer(deps: UiServerDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res);
  });
}
