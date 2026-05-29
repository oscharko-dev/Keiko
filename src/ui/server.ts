// The Wave 1 BFF (ADR-0011 D1/D2/D5). A hand-written node:http server with zero new runtime
// dependencies: it binds 127.0.0.1 only, sets the security headers + hash-based CSP on every
// response, rejects non-loopback Host/Origin (DNS-rebinding defense), dispatches the eleven-route
// API contract (only `GET /api/health` is live in Wave 1), and serves the static export from a
// path-traversal-safe contained root with an index fallback.

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
  type ApiError,
} from "./routes.js";

export const DEFAULT_UI_PORT = 4319;
export const UI_HOST = "127.0.0.1";

export interface UiServerDeps {
  // Absolute path to the directory holding the exported static assets (`dist/ui/static`).
  readonly staticRoot: string;
  // Precomputed CSP header value (with the static export's inline-script hashes folded in).
  readonly csp: string;
  // The port the server will bind; used to validate the request `Host`/`Origin` authority.
  readonly port: number;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function dispatchApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
): Promise<void> {
  const match = matchRoute(method, pathname);
  if (match === undefined) {
    writeJson(res, 404, notFoundBody());
    return;
  }
  if (match === "method-not-allowed") {
    writeJson(res, 405, methodNotAllowedBody());
    return;
  }
  const result = await match.definition.handler({ req, params: match.params });
  writeJson(res, result.status, result.body);
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
  const pathname = new URL(req.url ?? "/", `http://${UI_HOST}`).pathname;
  const apiPath = isApiPath(pathname);
  applySecurityHeaders(res, deps.csp, apiPath);
  if (!isAllowedHost(req, deps.port)) {
    rejectForbiddenHost(res);
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const work = apiPath
    ? dispatchApi(req, res, method, pathname)
    : serveStatic(res, deps.staticRoot, pathname);
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
