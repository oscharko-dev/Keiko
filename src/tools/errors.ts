// Re-export shim: tools error taxonomy lives in @oscharko-dev/keiko-tools (issue #162, ADR-0019),
// which itself re-exports from @oscharko-dev/keiko-security. All existing import sites
// (`from "../tools/errors.js"`) keep resolving unchanged via this barrel.

export {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  OutputLimitError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
  TOOL_CODES,
  ToolArgumentError,
  ToolError,
  UnknownToolError,
  type ToolCode,
} from "@oscharko-dev/keiko-tools";
