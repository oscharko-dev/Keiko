// Wave 1 local UI BFF (ADR-0011). A hand-written node:http server with zero new runtime
// dependencies that serves the static export and exposes the eleven-route JSON API contract; the
// browser tier is presentation-only and holds no secret, harness handle, or filesystem authority.

export { createUiServer, DEFAULT_UI_PORT, UI_HOST, type UiServerDeps } from "./server.js";
export { buildCspHeader, extractInlineScriptHashes } from "./csp.js";
export { loadCspHeader } from "./load-csp.js";
export { applySecurityHeaders } from "./headers.js";
export { isAllowedHost } from "./host-check.js";
export { resolveContainedPath, serveFile } from "./static.js";
export {
  API_ROUTES,
  isApiPath,
  matchRoute,
  errorBody,
  type ApiError,
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMatch,
  type RouteResult,
} from "./routes.js";
