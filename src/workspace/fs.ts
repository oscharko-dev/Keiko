// Re-export shim: the workspace FS port now lives in @oscharko-dev/keiko-workspace (issue #161).
export { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
export type { WorkspaceFs, WorkspaceStat, WorkspaceDirEntry } from "@oscharko-dev/keiko-workspace";
