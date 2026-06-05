// Public barrel for the keiko-server Quality Intelligence connector route group
// (Epic #270, Issue #278).
//
// Re-exports the additive connector route handlers, the authorisation predicates,
// and the safe-error helpers so the server route registrar can mount them as one
// cohesive group. The route group is DISABLED BY DEFAULT — every connector
// authorisation predicate returns `false` unless explicit config flips it.
//
// Nothing in this barrel performs IO or imports a provider SDK; the runtime
// behaviour lives in the existing keiko-server route plumbing.

export {
  isFigmaConnectorAuthorized,
  isJiraConnectorAuthorized,
  summariseQiConnectorCapabilities,
  type QiConnectorCapabilities,
  type QiConnectorConfig,
} from "./connectorAuthorization.js";
export {
  payloadContainsForbiddenSecretShape,
  qiConnectorErrorBody,
  type QiConnectorErrorBody,
  type QiConnectorErrorCode,
} from "./connectorErrors.js";
export {
  handleQiCapabilities,
  handleQiDryRunFigma,
  handleQiDryRunJira,
  handleQiSourceSelect,
} from "./connectorRoutes.js";
// Issue #280 — read-only UI routes for the Quality Intelligence panel.
export { handleListQiRuns, handleGetQiRun } from "./uiRoutes.js";
// Issue #281 — Conversation Center → QI workflow handoff route group.
export {
  QI_HANDOFF_ROUTE_GROUP,
  createHandleQiHandoff,
  handleQiHandoff,
  type QiHandoffRouteOptions,
  type QiHandoffSuccessBody,
} from "./handoffRoutes.js";
export {
  qiHandoffErrorBody,
  type QiHandoffErrorBody,
  type QiHandoffErrorCode,
} from "./handoffErrors.js";
