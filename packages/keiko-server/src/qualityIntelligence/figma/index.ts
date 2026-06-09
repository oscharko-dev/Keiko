// Local barrel for the server-side Figma connector (Epic #750, Issue #751).
//
// Intentionally NOT re-exported from the keiko-server Quality Intelligence package
// public barrel (../index.ts): these are internal server modules consumed by the route
// tier, kept out of the package public surface so `check:package-surface` stays stable.
//
// The connector is disabled-until-configured (no token ⇒ FIGMA_TOKEN_MISSING), reads the
// read-only PAT server-side only, and never logs/returns/embeds the token.

export {
  createFigmaConnector,
  type FigmaConnector,
  type FigmaConnectorConfig,
  type FigmaConnectorDeps,
  type FigmaEnv,
  type FigmaFetchOptions,
  type FigmaProvenance,
  type FigmaScopedResult,
} from "./figmaConnector.js";
export {
  createDefaultFigmaHttpPort,
  type FigmaHttpPort,
  type FigmaHttpRequest,
  type FigmaHttpResponse,
} from "./figmaHttpPort.js";
export {
  FigmaConnectorError,
  figmaConnectorErrorBody,
  type FigmaConnectorErrorBody,
  type FigmaConnectorErrorCode,
} from "./figmaConnectorErrors.js";
export { parseFigmaTarget, type FigmaTarget } from "./figmaUrl.js";
export {
  resolveReadiness,
  type FigmaNode,
  type FigmaDevStatus,
  type ReadinessOptions,
  type ReadinessSignal,
} from "./figmaReadiness.js";
