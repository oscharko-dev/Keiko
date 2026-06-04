// Re-export shim: the tools error taxonomy now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "./errors.js"`) keep resolving
// unchanged via this barrel.

export {
  TOOL_CODES,
  ToolError,
  ToolArgumentError,
  UnknownToolError,
  CommandDeniedError,
  CommandTimeoutError,
  CommandCancelledError,
  OutputLimitError,
  PatchValidationError,
  PatchApplyDisabledError,
  PatchApplyError,
} from "@oscharko-dev/keiko-security/errors/tools";
export type { ToolCode } from "@oscharko-dev/keiko-security/errors/tools";
