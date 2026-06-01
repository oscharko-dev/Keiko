// Browser tool barrel — re-exports the public surface that BFF handlers and tests compose.
// ADR-0017. No runtime side effects.

export { BROWSER_ERROR_CODES, BrowserToolError, type BrowserErrorCode } from "./errors.js";

export {
  isLoopbackHost,
  isLoopbackUrl,
  normalizeCdpPort,
  normalizeNavigateUrl,
} from "./validators.js";

export type {
  BrowserContentResult,
  BrowserNavigateResult,
  BrowserScreenshotPersisted,
  BrowserScreenshotPreview,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  BrowserSessionStatus,
  BrowserViewportPx,
  CdpReachability,
  NormalizedNavigateUrl,
} from "./types.js";

export {
  CdpClient,
  PERMITTED_CDP_METHODS,
  type CdpCloseListener,
  type CdpClientOptions,
  type CdpEventListener,
} from "./cdp-client.js";

export {
  createBrowserSessionManager,
  type BrowserEventEmitter,
  type BrowserEventEnvelope,
  type BrowserEventKind,
  type BrowserSessionManager,
  type BrowserSessionManagerOptions,
} from "./session.js";
