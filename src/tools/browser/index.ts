// Re-export shim: the browser CDP sub-surface lives in @oscharko-dev/keiko-tools (issue #162,
// ADR-0019). All existing import sites (`from "../tools/browser/index.js"`) keep resolving
// unchanged via this barrel. Mirrors the pre-move surface of src/tools/browser/index.ts.

export {
  BROWSER_ERROR_CODES,
  BrowserToolError,
  type BrowserErrorCode,
} from "@oscharko-dev/keiko-tools";
export {
  isLoopbackHost,
  isLoopbackUrl,
  normalizeCdpPort,
  normalizeNavigateUrl,
} from "@oscharko-dev/keiko-tools";
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
} from "@oscharko-dev/keiko-tools";
export {
  CdpClient,
  PERMITTED_CDP_METHODS,
  type CdpCloseListener,
  type CdpClientOptions,
  type CdpEventListener,
} from "@oscharko-dev/keiko-tools";
export {
  createBrowserSessionManager,
  type BrowserEventEmitter,
  type BrowserEventEnvelope,
  type BrowserEventKind,
  type BrowserSessionManager,
  type BrowserSessionManagerOptions,
} from "@oscharko-dev/keiko-tools";
