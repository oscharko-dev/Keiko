// Re-export shim: the WorkspaceToolHost (ToolPort implementation) lives in
// @oscharko-dev/keiko-tools (issue #162, ADR-0019). All existing import sites
// (`from "../tools/registry.js"`) keep resolving unchanged via this barrel.

export { WorkspaceToolHost } from "@oscharko-dev/keiko-tools";
