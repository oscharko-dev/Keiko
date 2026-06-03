// Re-export shim: the workspace error taxonomy is owned by @oscharko-dev/keiko-security and
// re-exported through @oscharko-dev/keiko-workspace (issues #159, #161). Routing this shim
// through keiko-workspace keeps the legacy `from "./errors.js"` import paths resolving for
// callers that have not yet been migrated to the absolute package surface.

export {
  WORKSPACE_CODES,
  WorkspaceError,
  PathEscapeError,
  PathDeniedError,
  WorkspaceNotFoundError,
  FileTooLargeError,
  WorkspaceReadError,
} from "@oscharko-dev/keiko-workspace";
export type { WorkspaceCode } from "@oscharko-dev/keiko-workspace";
