// Re-export shim: the browser session manager lives in @oscharko-dev/keiko-tools (issue #162,
// ADR-0019). All existing import sites (`from "../tools/browser/session.js"`) keep resolving
// unchanged via this barrel.

export {
  createBrowserSessionManager,
  type BrowserEventEmitter,
  type BrowserEventEnvelope,
  type BrowserEventKind,
  type BrowserSessionManager,
  type BrowserSessionManagerOptions,
  type BrowserSideFileWriter,
} from "@oscharko-dev/keiko-tools";
