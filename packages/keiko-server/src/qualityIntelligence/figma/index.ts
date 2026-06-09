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
  createDefaultFigmaRenderPort,
  type FigmaRenderPort,
  type FigmaRenderRequest,
  type FigmaRenderResponse,
} from "./figmaRenderPort.js";
export { buildFigmaSnapshot, type BuildFigmaSnapshotInput } from "./figmaSnapshotBuilder.js";
export {
  resnapshotFigma,
  type FigmaCleanToIr,
  type ResnapshotFigmaDeps,
} from "./figmaResnapshot.js";
export {
  fetchWithBackoff,
  realFigmaRetrySleep,
  DEFAULT_FIGMA_RETRY_POLICY,
  type FigmaBackoffResponse,
  type FigmaRetryPolicy,
  type FigmaRetrySleep,
} from "./figmaRetry.js";
export { mapWithConcurrency } from "./figmaConcurrency.js";
export type {
  FigmaRenderedImage,
  FigmaSkippedScreen,
  FigmaSkippedScreenReason,
  FigmaSnapshot,
  FigmaSnapshotScreen,
} from "./figmaSnapshotTypes.js";
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
export {
  createFigmaTokenStore,
  resolveFigmaVaultKey,
  NO_FIGMA_KEYCHAIN,
  type FigmaTokenStore,
  type FigmaTokenStoreDeps,
  type FigmaKeychainAccess,
  type FigmaVaultKeySource,
  type ResolvedFigmaVaultKey,
} from "./figmaTokenStore.js";
export {
  resolveFigmaToken,
  classifyTokenFailure,
  type FigmaTokenSources,
} from "./figmaTokenSource.js";
export { deriveFigmaScopeRef, type FigmaScopeRef } from "./figmaScopeRef.js";
export {
  appendFigmaConnectorAudit,
  loadFigmaConnectorAudit,
  FIGMA_AUDIT_SCHEMA_VERSION,
  type AppendFigmaConnectorAuditInput,
  type FigmaConnectorAction,
  type FigmaConnectorAuditArtifact,
  type FigmaConnectorAuditCounts,
  type FigmaConnectorAuditEntry,
  type FigmaConnectorOutcome,
} from "./figmaConnectorAudit.js";
export {
  recordReadOnlyConsent,
  loadReadOnlyConsent,
  hasReadOnlyConsent,
  assertReadOnlyConsent,
  EXPECTED_FIGMA_SCOPES,
  FIGMA_CONSENT_SCHEMA_VERSION,
  type FigmaScopeConsent,
  type RecordReadOnlyConsentInput,
} from "./figmaConsent.js";
export {
  computeFigmaConnectorMetrics,
  type FigmaA11yMetrics,
  type FigmaAugmentationShare,
  type FigmaAugmentationTally,
  type FigmaConnectorMetrics,
  type FigmaConnectorMetricsExtras,
  type FigmaNavGraphMetrics,
} from "./figmaConnectorMetrics.js";
export {
  observeFigmaSnapshot,
  observeFigmaRevoke,
  type ObservedActionContext,
  type ObservedRevokeInput,
  type ObservedSnapshotInput,
  type ObservedSnapshotResult,
} from "./figmaObservedActions.js";
