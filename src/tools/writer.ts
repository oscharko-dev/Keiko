// Re-export shim: the WorkspaceWriter port + nodeWorkspaceWriter adapter live in
// @oscharko-dev/keiko-tools (issue #162, ADR-0019). All existing import sites
// (`from "../tools/writer.js"`) keep resolving unchanged via this barrel.

export { nodeWorkspaceWriter } from "@oscharko-dev/keiko-tools/internal/writer";
export type { WorkspaceWriter } from "@oscharko-dev/keiko-tools";
