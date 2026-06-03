// Re-export shim: the workspace error taxonomy now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "./errors.js"`) keep resolving
// unchanged via this barrel.

export {
  WORKSPACE_CODES,
  WorkspaceError,
  PathEscapeError,
  PathDeniedError,
  WorkspaceNotFoundError,
  FileTooLargeError,
  WorkspaceReadError,
} from "@oscharko-dev/keiko-security/errors/workspace";
export type { WorkspaceCode } from "@oscharko-dev/keiko-security/errors/workspace";
