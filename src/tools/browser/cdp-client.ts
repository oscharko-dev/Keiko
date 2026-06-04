// Re-export shim: the CDP WebSocket client lives in @oscharko-dev/keiko-tools (issue #162,
// ADR-0019). All existing import sites (`from "../tools/browser/cdp-client.js"`) keep resolving
// unchanged via this barrel.

export {
  CdpClient,
  PERMITTED_CDP_METHODS,
  type CdpCloseListener,
  type CdpClientOptions,
  type CdpEventListener,
} from "@oscharko-dev/keiko-tools";
