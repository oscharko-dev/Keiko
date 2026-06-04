// Re-export shim: browser tool result/meta types live in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/browser/types.js"`) keep
// resolving unchanged via this barrel.

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
