// Wave 2 local UI BFF (ADR-0011). A hand-written node:http server with zero new runtime
// dependencies that serves the static export and exposes the eleven-route JSON + SSE API contract;
// the browser tier is presentation-only and holds no secret, harness handle, or filesystem authority.

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
  STREAMING,
  type ApiError,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMatch,
  type RouteResult,
} from "./routes.js";
export {
  buildUiHandlerDeps,
  buildRedactor,
  type UiHandlerDeps,
  type BuildHandlerDepsOptions,
  type Redactor,
  type ModelPortFactory,
} from "./deps.js";
export {
  createRunRegistry,
  ActiveRunLimitError,
  type RunRegistry,
  type RunRecord,
  type RunStatus,
  type AppliableSnapshot,
} from "./runs.js";
export { QueueEventSink, type StreamEvent, type SseWriter } from "./sink.js";
export { parseRunRequest, type RunRequest, type RunKind } from "./run-request.js";
export { startRun, applyRun, type StartRunResult } from "./run-engine.js";
export {
  handleCreateRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";
export {
  persistWorkflowEvidence,
  persistExplainEvidence,
  type EvidencePersistContext,
  type RunIdentity,
} from "./evidence.js";
