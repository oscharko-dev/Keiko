// Re-export shim: browser tool error codes + BrowserToolError live in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/browser/errors.js"`) keep
// resolving unchanged via this barrel.

export {
  BROWSER_ERROR_CODES,
  BrowserToolError,
  type BrowserErrorCode,
} from "@oscharko-dev/keiko-tools";
