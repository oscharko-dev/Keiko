// Re-export shim: the workspace barrel now lives in @oscharko-dev/keiko-workspace (issue #161,
// ADR-0019). All existing import sites (`from "../workspace/index.js"`, etc.) keep resolving
// unchanged via this barrel. Mirrors the contracts/security/model-gateway extraction patterns.
export { DEFAULT_CONTEXT_REQUEST, DEFAULT_DISCOVERY_OPTIONS, DEFAULT_READ_OPTIONS, SELECTION_REASON_PRIORITY, } from "@oscharko-dev/keiko-workspace";
export { FileTooLargeError, PathDeniedError, PathEscapeError, WORKSPACE_CODES, WorkspaceError, WorkspaceNotFoundError, WorkspaceReadError, } from "@oscharko-dev/keiko-workspace";
export {} from "@oscharko-dev/keiko-workspace";
export { isWithinWorkspace, resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";
export { compileIgnore, DEFAULT_DENY_PATTERNS, isDenied, isIgnored, } from "@oscharko-dev/keiko-workspace";
export { detectWorkspace } from "@oscharko-dev/keiko-workspace";
export { discoverFiles, discoverWithStats, readWorkspaceFile, } from "@oscharko-dev/keiko-workspace";
export { lexicalRetrievalStrategy, } from "@oscharko-dev/keiko-workspace";
export { buildContextPack, buildContextPackFromFiles, } from "@oscharko-dev/keiko-workspace";
export { buildWorkspaceSummary, summarizeForAudit } from "@oscharko-dev/keiko-workspace";
// Note: nodeWorkspaceFs, assertContainedRealPath, and containedRealPathInfo are intentionally
// NOT re-exported through this legacy barrel. They were never on the pre-extraction
// `src/workspace/index.ts` surface (verified against tests/sdk/sdk.test.ts which asserts
// `nodeWorkspaceFs` does not leak through the SDK/root barrel re-export chain). Callers
// that need them continue to import from the per-file shims `src/workspace/fs.js` and
// `src/workspace/realpath.js`, both of which re-export from @oscharko-dev/keiko-workspace.
